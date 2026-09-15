import fs from 'node:fs';
import path from 'node:path';
import { forgetSecret, registerSecret } from './secrets.mjs';

export class CredentialStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    for (const secret of Object.values(this.data)) registerSecret(secret);
  }

  get(ref) { return this.data[ref] ?? null; }

  has(ref) { return Boolean(this.get(ref)); }

  set(ref, secret) {
    const value = String(secret ?? '').trim();
    if (!ref || !value) throw new Error('credential reference and secret are required');
    const previous = this.data[ref];
    if (previous) forgetSecret(previous);
    registerSecret(value);
    this.data[ref] = value;
    this.save();
    return ref;
  }

  remove(ref) {
    const secret = this.data[ref];
    if (!secret) return false;
    delete this.data[ref];
    forgetSecret(secret);
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
  }
}
