import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { channels: {} };
    this.load();
  }
  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.data = { channels: {} }; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  getChannel(channelId, defaultCwd) {
    return this.data.channels[channelId] || { cwd: defaultCwd, sessionId: null };
  }
  patchChannel(channelId, patch, defaultCwd) {
    const current = this.getChannel(channelId, defaultCwd);
    this.data.channels[channelId] = { ...current, ...patch };
    this.save();
    return this.data.channels[channelId];
  }
}
