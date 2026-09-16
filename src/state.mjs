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

/** Stable key for a workspace directory (Windows paths are case-insensitive). */
export function workspaceKey(cwd) {
  if (!cwd) return null;
  const resolved = path.resolve(String(cwd));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { channels: {}, workspaces: {}, preferences: {} };
    this.load();
  }
  load() {
    try {
      // A leading UTF-8 BOM (easy to produce from Windows PowerShell) makes
      // JSON.parse throw, and a silent fallback to empty state is exactly how a
      // configured channel can end up back on Chat defaults. Strip it explicitly.
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      this.data = parsed && typeof parsed === 'object' ? parsed : { channels: {} };
      if (!this.data.channels || typeof this.data.channels !== 'object') this.data.channels = {};
      if (!this.data.workspaces || typeof this.data.workspaces !== 'object') this.data.workspaces = {};
      if (!this.data.preferences || typeof this.data.preferences !== 'object') this.data.preferences = {};
    }
    catch { this.data = { channels: {}, workspaces: {}, preferences: {} }; }
    this.#backfillWorkModels();
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

  // ---- selected model persistence ------------------------------------------
  // A Discord channel/thread is ephemeral (a new Work thread is created for
  // every task), so the selected model is persisted on two stable scopes:
  //   workspaces[<cwd>]        → per project directory
  //   preferences.lastWorkModel → last model the owner selected anywhere
  // Both are validated against the live provider before use; an unknown saved
  // model produces an explicit error instead of a silent switch.

  /** The saved work-model selection for a project directory, or null. */
  getWorkspaceModel(cwd) {
    const key = workspaceKey(cwd);
    if (!key) return null;
    return this.data.workspaces[key] ?? null;
  }

  /** The last work-model selection the owner made, or null. */
  getLastWorkModel() {
    return this.data.preferences?.lastWorkModel ?? null;
  }

  /**
   * Persist the work-model selection at channel, workspace and last-known scope
   * in a single atomic write. Never called with an empty model.
   */
  rememberWorkModel({ channelId = null, cwd = null, providerId = null, executorId = null, model, at = new Date().toISOString() } = {}) {
    if (!model) return null;
    const entry = { providerId, executorId, model, updatedAt: at };
    if (channelId) {
      const current = this.getChannel(channelId, cwd || process.cwd());
      this.data.channels[channelId] = { ...current, model };
    }
    const key = workspaceKey(cwd);
    if (key) this.data.workspaces[key] = entry;
    this.data.preferences = this.data.preferences ?? {};
    this.data.preferences.lastWorkModel = entry;
    this.save();
    return entry;
  }

  /** Count of workspaces with a restored selection (for startup logging). */
  savedWorkspaceModelCount() {
    return Object.keys(this.data.workspaces ?? {}).length;
  }

  /**
   * One-time upgrade for existing state files: derive workspace + last-known
   * selections from channels that already carry a model, so a bridge that had a
   * working model before this change does not lose it. Deterministic: later
   * channel entries win.
   */
  #backfillWorkModels() {
    const channels = Object.entries(this.data.channels ?? {});
    let changed = false;
    let last = this.data.preferences?.lastWorkModel ?? null;
    for (const [, value] of channels) {
      if (!value?.model) continue;
      const entry = {
        providerId: value.providerId ?? null,
        executorId: value.executorId ?? null,
        model: value.model,
        updatedAt: value.updatedAt ?? null,
      };
      const key = workspaceKey(value.cwd);
      if (key && !this.data.workspaces[key]) { this.data.workspaces[key] = entry; changed = true; }
      last = entry;
    }
    if (last && !this.data.preferences?.lastWorkModel) {
      this.data.preferences = this.data.preferences ?? {};
      this.data.preferences.lastWorkModel = last;
      changed = true;
    }
    if (changed) this.save();
  }
}
