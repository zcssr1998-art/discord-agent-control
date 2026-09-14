import fs from 'node:fs';
import path from 'node:path';

/**
 * Full Claude Code stdout/stderr goes here, never to Discord.
 *
 * Discord only ever shows throttled, human-level progress; the raw stream-json
 * transcript is written to `logs/` (git-ignored) so a failed run can be debugged
 * after the fact without flooding the phone.
 */
export class RunLogger {
  constructor(dir) {
    this.dir = dir;
    this.enabled = Boolean(dir);
    if (this.enabled) fs.mkdirSync(this.dir, { recursive: true });
  }

  static safeId(value) {
    return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  }

  open({ channelId, prompt }) {
    if (!this.enabled) {
      return { path: null, log: () => {}, close: () => {} };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.dir, `${stamp}-${RunLogger.safeId(channelId)}.jsonl`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    // An async write failure (EPIPE / ENOSPC / EBADF) is emitted as an 'error'
    // event, which throws when nothing is listening — and an uncaught throw
    // would take the whole bridge, Discord control plane included, down with it.
    // Logging must never be able to do that.
    stream.on('error', () => { /* the transcript is best-effort */ });
    stream.write(JSON.stringify({ type: 'prompt', at: new Date().toISOString(), prompt }) + '\n');
    return {
      path: file,
      log: (entry) => {
        try { stream.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
        catch { /* logging must never break a run */ }
      },
      close: () => { try { stream.end(); } catch { /* ignore */ } },
    };
  }
}
