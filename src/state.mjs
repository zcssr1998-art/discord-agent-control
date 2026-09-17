import fs from 'node:fs';
import path from 'node:path';
import { needsChatSelectionRepair } from './model-selection.mjs';
import { DEFAULT_LEVEL } from './permission-manager.mjs';

/** Bumped when the owner-default profile shape changes; read for migration. */
export const OWNER_SETTINGS_VERSION = 1;

/**
 * The canonical product routing defaults. This is the ONE source of truth for
 * "product defaults": per-channel defaults, owner-default fallbacks and the
 * `初始化设置` reset all derive from it instead of duplicating literals.
 *
 * `workspace` is intentionally null here: the persistent workspace selection is
 * owned by the existing global-workspace mechanism (`preferences.workspace`) and
 * only surfaced through `getOwnerDefaults()`.
 */
export function productRoutingDefaults() {
  return {
    executorId: 'workbuddy',
    providerId: 'workbuddy-free',
    model: null,
    chatProviderId: 'auto',
    chatModel: null,
    permission: DEFAULT_LEVEL,
    workspace: null,
  };
}

/** Channel fields that only exist to override the routing/settings defaults. */
const ROUTING_CHANNEL_KEYS = ['executorId', 'providerId', 'model', 'chatProviderId', 'chatModel', 'cwd'];

export function defaultChannelState(defaultCwd) {
  const routing = productRoutingDefaults();
  return {
    mode: 'chat',
    chatProviderId: routing.chatProviderId,
    chatModel: routing.chatModel,
    cwd: defaultCwd,
    executorId: routing.executorId,
    providerId: routing.providerId,
    model: routing.model,
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
    this.#seedOwnerDefaults();
    this.#repairChatSelections();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /**
   * A channel's effective state. Owner defaults are the fallback UNDER the
   * channel's own stored fields, so an existing entry (e.g. one created only by
   * a Chat selection or a mode switch) still inherits the durable owner Work
   * route for every field it did not explicitly set. Precedence is therefore
   * explicit channel field > owner default > product built-in.
   */
  getChannel(channelId, defaultCwd) {
    const base = defaultChannelState(defaultCwd);
    const layered = this.ownerRoutingOverrides(base);
    const stored = this.data.channels?.[channelId];
    if (!stored || typeof stored !== 'object') return layered;
    return { ...layered, ...stored };
  }

  /**
   * Owner defaults mapped onto the routing fields a channel state exposes. The
   * Work model is intentionally NOT mapped here: it is resolved later by the
   * model resolver as a lower-priority candidate, so a workspace-specific saved
   * selection still wins over the owner default (see SessionManager).
   */
  ownerRoutingOverrides(base = {}) {
    const owner = this.getOwnerDefaults();
    const out = { ...base };
    if (owner.executorId) out.executorId = owner.executorId;
    if (owner.providerId) out.providerId = owner.providerId;
    if (owner.chatProviderId) out.chatProviderId = owner.chatProviderId;
    out.chatModel = owner.chatModel ?? null;
    if (owner.workspace) out.cwd = owner.workspace;
    return out;
  }

  // ---- durable owner defaults ----------------------------------------------
  // One persisted profile of the owner's explicitly chosen settings. It is the
  // fallback (after an explicit channel/workspace selection) for a scope with no
  // local override, so a restart / new Work thread / new channel never silently
  // reverts to hard-coded values. Only stable configuration belongs here:
  // session ids, run state, approvals, cooldowns and transient cwd are excluded.

  /** The owner-default profile merged over the canonical product defaults. */
  getOwnerDefaults() {
    const defaults = productRoutingDefaults();
    const stored = this.data.preferences?.ownerDefaults;
    if (stored && typeof stored === 'object') {
      for (const key of Object.keys(defaults)) {
        if (key === 'workspace') continue;
        if (stored[key] !== undefined) defaults[key] = stored[key];
      }
    }
    // The persistent workspace selection stays owned by the global-workspace
    // mechanism; the profile only exposes it.
    defaults.workspace = this.getGlobalWorkspace()?.path ?? null;
    return defaults;
  }

  /** The durable owner-default permission tier (canonical default when unset). */
  getOwnerDefaultPermission() {
    return this.getOwnerDefaults().permission;
  }

  /**
   * Persist an explicit owner choice as the durable default for future scopes.
   * Unknown keys are ignored (schema-version-safe). `workspace` routes through
   * the existing global-workspace mechanism rather than being duplicated.
   */
  setOwnerDefaults(patch = {}) {
    const known = productRoutingDefaults();
    const next = { ...(this.data.preferences?.ownerDefaults ?? {}) };
    for (const key of Object.keys(known)) {
      if (key === 'workspace') continue;
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    this.data.preferences = this.data.preferences ?? {};
    this.data.preferences.ownerDefaults = next;
    this.data.preferences.ownerSettingsVersion = OWNER_SETTINGS_VERSION;
    if (patch.workspace !== undefined) {
      if (patch.workspace) this.setGlobalWorkspace(patch.workspace);
      else this.clearGlobalWorkspace();
    }
    this.save();
    return this.getOwnerDefaults();
  }

  /**
   * `初始化设置`: reset the user-configurable settings layer to the canonical
   * product defaults. It removes the owner-default profile, the saved workspace
   * model selections and the persisted permission tiers, and neutralizes
   * per-channel routing overrides that would otherwise immediately reapply the
   * old configuration.
   *
   * It deliberately does NOT touch credentials, provider accounts, the Discord
   * token, chat/task history, the run database, logs, updater state, channel
   * mode/thread/session bookkeeping or any repository files.
   */
  resetOwnerSettings() {
    const preferences = this.data.preferences ?? {};
    delete preferences.ownerDefaults;
    delete preferences.lastWorkModel;
    delete preferences.workspace;
    preferences.ownerSettingsVersion = OWNER_SETTINGS_VERSION;
    this.data.preferences = preferences;
    // Workspace-scoped model entries exist only to override the routing default.
    this.data.workspaces = {};
    // Persisted tiers exist only to override the owner-default permission.
    this.data.permissions = {};
    for (const [channelId, value] of Object.entries(this.data.channels ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const next = { ...value };
      for (const key of ROUTING_CHANNEL_KEYS) delete next[key];
      this.data.channels[channelId] = next;
    }
    this.save();
    return this.getOwnerDefaults();
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
    // An explicit Work model selection is exactly the owner configuration that
    // must become the durable default for future scopes.
    this.data.preferences.ownerDefaults = {
      ...(this.data.preferences.ownerDefaults ?? {}),
      ...(executorId ? { executorId } : {}),
      ...(providerId ? { providerId } : {}),
      model,
    };
    this.data.preferences.ownerSettingsVersion = OWNER_SETTINGS_VERSION;
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
   * One-time upgrade seeding for the owner-default profile. It is derived ONLY
   * from the already-unambiguous `lastWorkModel` selection (which the backfill
   * derives from an existing channel's explicit model). Permission and Chat pins
   * are scope-specific and ambiguous, so they are not guessed: they wait for the
   * next explicit owner choice. Existing state with no selection is left alone.
   */
  #seedOwnerDefaults() {
    const preferences = this.data.preferences ?? {};
    if (preferences.ownerSettingsVersion === OWNER_SETTINGS_VERSION) return;
    if (preferences.ownerDefaults && typeof preferences.ownerDefaults === 'object') {
      preferences.ownerSettingsVersion = OWNER_SETTINGS_VERSION;
      this.data.preferences = preferences;
      this.save();
      return;
    }
    const last = this.getLastWorkModel();
    preferences.ownerSettingsVersion = OWNER_SETTINGS_VERSION;
    if (last?.model) {
      preferences.ownerDefaults = {
        ...(last.executorId ? { executorId: last.executorId } : {}),
        ...(last.providerId ? { providerId: last.providerId } : {}),
        model: last.model,
      };
    }
    this.data.preferences = preferences;
    this.save();
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
