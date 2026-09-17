import fs from 'node:fs';
import path from 'node:path';
import { needsChatSelectionRepair } from './model-selection.mjs';

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
    this.data = { channels: {}, workspaces: {}, preferences: {}, permissions: {} };
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
      if (!this.data.permissions || typeof this.data.permissions !== 'object') this.data.permissions = {};
    }
    catch { this.data = { channels: {}, workspaces: {}, preferences: {}, permissions: {} }; }
    this.#backfillWorkModels();
    this.#repairChatSelections();
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
    const entry = { providerId, executorId, model, cwd: cwd ?? null, updatedAt: at };
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

  // ---- persistent owner permission tier -------------------------------------
  // The selected level is product configuration, not Agent session state: it is
  // persisted so a bridge restart, new Work thread, model/provider/executor or
  // workspace change never silently downgrades the owner (e.g. FULL -> STANDARD).
  // Existing state without a persisted tier naturally migrates to the manager's
  // default (STANDARD).

  /** The persisted level for a channel, or null when the owner never chose one. */
  getPermissionLevel(channelId) {
    if (!channelId) return null;
    const level = this.data.permissions?.[channelId];
    return typeof level === 'string' ? level : null;
  }

  /** All persisted channel levels, for restoring the PermissionManager on start. */
  allPermissionLevels() {
    return { ...(this.data.permissions ?? {}) };
  }

  /** Persist one explicit owner permission choice. */
  setPermissionLevel(channelId, level) {
    if (!channelId || typeof level !== 'string') return null;
    this.data.permissions = this.data.permissions ?? {};
    this.data.permissions[channelId] = level;
    this.save();
    return level;
  }

  // ---- global workspace (user-chosen default task directory) ----------------
  // Separate from work models and from per-run directories: a run in a temporary
  // folder must never rewrite this. Only `!workspace <path>` writes it.

  /** The user-selected persistent workspace, or null. */
  getGlobalWorkspace() {
    const entry = this.data.preferences?.workspace ?? null;
    return entry?.path ? entry : null;
  }

  /** Persist the user-selected workspace (validated by the caller). */
  setGlobalWorkspace(workspacePath, { at = new Date().toISOString() } = {}) {
    if (!workspacePath) return null;
    this.data.preferences = this.data.preferences ?? {};
    this.data.preferences.workspace = { path: workspacePath, source: 'user', updatedAt: at };
    this.save();
    return this.data.preferences.workspace;
  }

  /** Forget the user-selected workspace so the config/repo default applies. */
  clearGlobalWorkspace() {
    if (!this.data.preferences?.workspace) return false;
    delete this.data.preferences.workspace;
    this.save();
    return true;
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
        cwd: value.cwd ?? null,
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

  /**
   * One-time-per-load repair for the P2.2.2 bug: a documentation placeholder
   * (`<model-id>` / `<provider-id>` / ...) must never stay a persisted Chat pin.
   * Only the Chat selection fields are touched; Work model, workspace, history,
   * permissions and session fields are preserved. The repaired state is written
   * back immediately so the bug cannot reappear after the next reboot.
   */
  #repairChatSelections() {
    const channels = this.data.channels ?? {};
    let changed = false;
    for (const [channelId, value] of Object.entries(channels)) {
      if (!value || typeof value !== 'object') continue;
      if (!needsChatSelectionRepair({ providerId: value.chatProviderId, model: value.chatModel })) continue;
      channels[channelId] = { ...value, chatProviderId: 'auto', chatModel: null };
      changed = true;
      console.log(`[state] repaired invalid Chat selection for channel=${channelId} -> AUTO`);
    }
    if (changed) this.save();
  }
}
