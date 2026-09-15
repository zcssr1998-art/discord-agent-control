import fs from 'node:fs';
import path from 'node:path';

export function defaultChannelState(defaultCwd) {
  return {
    mode: 'chat',
    chatProviderId: 'auto',
    chatModel: null,
    cwd: defaultCwd,
    executorId: 'workbuddy',
    providerId: 'workbuddy-free',
    model: null,
    sessionId: null,
  };
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { channels: {} };
    this.load();
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = parsed && typeof parsed === 'object' ? parsed : { channels: {} };
      if (!this.data.channels || typeof this.data.channels !== 'object') this.data.channels = {};
    }
    catch { this.data = { channels: {} }; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  getChannel(channelId, defaultCwd) {
    return { ...defaultChannelState(defaultCwd), ...(this.data.channels[channelId] || {}) };
  }
  patchChannel(channelId, patch, defaultCwd) {
    const current = this.getChannel(channelId, defaultCwd);
    this.data.channels[channelId] = { ...current, ...patch };
    this.save();
    return this.data.channels[channelId];
  }
}
