import { normalizeChatSelection } from './model-selection.mjs';

export class SessionManager {
  constructor({ state, permissionManager, approvalManager, defaultCwd, stopRunner = async () => {}, isRunning = () => false, chatModelResolver = null }) {
    this.state = state;
    this.permissions = permissionManager;
    this.approvals = approvalManager;
    this.defaultCwd = defaultCwd;
    this.stopRunner = stopRunner;
    this.isRunning = isRunning;
    this.chatModelResolver = chatModelResolver;
  }

  get(channelId) {
    return {
      mode: 'chat',
      chatProviderId: 'auto',
      chatModel: null,
      cwd: this.defaultCwd,
      executorId: 'workbuddy',
      providerId: 'workbuddy-free',
      model: null,
      sessionId: null,
      ...this.state.getChannel(channelId, this.defaultCwd),
    };
  }

  snapshot(channelId) {
    const value = this.get(channelId);
    return { ...value, executorSessionId: value.sessionId, permission: this.permissions.getLevel(channelId) };
  }

  setMode(channelId, mode) {
    if (!['chat', 'work'].includes(mode)) throw Object.assign(new Error('invalid mode'), { code: 'INVALID_MODE' });
    return this.state.patchChannel(channelId, { mode }, this.defaultCwd);
  }

  setChatSelection(channelId, { providerId = 'auto', model = null } = {}) {
    const selection = normalizeChatSelection({ providerId, model });
    return this.state.patchChannel(channelId, { chatProviderId: selection.providerId, chatModel: selection.model }, this.defaultCwd);
  }

  /**
   * The single Chat-selection entry point for UI commands/panel buttons. It runs
   * the same syntactic placeholder validation as `setChatSelection` and, when the
   * provider can actually enumerate models, requires an exact model match before
   * persisting. A provider that genuinely cannot enumerate models is still
   * accepted (custom OpenAI/Anthropic-compatible providers), but placeholder
   * syntax is always rejected.
   */
  async resolveChatSelection(channelId, { providerId = 'auto', model = null } = {}) {
    const selection = normalizeChatSelection({ providerId, model });
    if (selection.providerId !== 'auto' && this.chatModelResolver) {
      const models = await this.#listChatModels(selection.providerId);
      if (Array.isArray(models) && models.length) {
        const found = models.some((entry) => {
          const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.displayName);
          const name = typeof entry === 'string' ? entry : entry?.displayName;
          return id === selection.model || name === selection.model;
        });
        if (!found) {
          throw Object.assign(new Error('chat model is not offered by the provider'), {
            code: 'INVALID_CHAT_SELECTION', field: 'model', value: selection.model,
          });
        }
      }
    }
    return this.setChatSelection(channelId, selection);
  }

  async #listChatModels(providerId) {
    try {
      const result = await this.chatModelResolver(providerId);
      if (Array.isArray(result)) return result;
      return Array.isArray(result?.models) ? result.models : null;
    } catch { return null; }
  }

  bindExecutorSession(channelId, executorSessionId) {
    this.state.patchChannel(channelId, { sessionId: executorSessionId }, this.defaultCwd);
    this.permissions.syncSession(executorSessionId, channelId);
  }

  /**
   * Remember a Work model selection at channel + workspace + last-known scope so
   * a bridge restart, a new Work thread, or a brand-new channel in the same
   * project restores it without asking the owner to run `!model` again.
   */
  rememberWorkModel(channelId, { providerId = null, executorId = null, model } = {}) {
    if (!model) return null;
    const cwd = this.get(channelId).cwd;
    return this.state.rememberWorkModel({ channelId, cwd, providerId, executorId, model });
  }

  /**
   * The persisted model candidates for a channel, most specific first:
   * workspace (same project directory) then the last selection anywhere.
   * Entries carry their provider so a stale route can never be applied blindly.
   */
  savedModelCandidates(channelId) {
    return this.savedModelCandidatesForCwd(this.get(channelId).cwd);
  }

  /** Same as savedModelCandidates() for a bare directory (startup card, /status). */
  savedModelCandidatesForCwd(cwd) {
    const candidates = [this.state.getWorkspaceModel(cwd), this.state.getLastWorkModel()].filter(Boolean);
    const seen = new Set();
    return candidates.filter((entry) => {
      const key = `${entry.providerId ?? '?'}:${entry.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async change(channelId, patch, reason) {
    if (this.isRunning(channelId)) throw Object.assign(new Error('task is running'), { code: 'RUNNING' });
    const current = this.get(channelId);
    await this.stopRunner(channelId, reason);
    if (current.sessionId) {
      this.approvals.cancelForSession(current.sessionId, reason);
      this.approvals.clearSessionAllows(current.sessionId);
    }
    this.permissions.reset(channelId, reason);
    return this.state.patchChannel(channelId, { ...patch, sessionId: null }, this.defaultCwd);
  }

  reset(channelId) { return this.change(channelId, {}, 'reset'); }

  async invalidateProvider(providerId) {
    const channels = Object.entries(this.state.data.channels ?? {})
      .filter(([, value]) => value.providerId === providerId || value.chatProviderId === providerId)
      .map(([channelId]) => channelId);
    if (channels.some((channelId) => this.isRunning(channelId))) {
      throw Object.assign(new Error('task is running'), { code: 'RUNNING' });
    }
    const changed = [];
    for (const channelId of channels) {
      const current = this.get(channelId);
      const patch = {};
      if (current.providerId === providerId) Object.assign(patch, { providerId: null, model: null });
      if (current.chatProviderId === providerId) Object.assign(patch, { chatProviderId: 'auto', chatModel: null });
      // Only an Agent-provider removal needs to discard the Agent session and permissions.
      if (current.providerId === providerId) await this.change(channelId, patch, 'provider removed');
      else this.state.patchChannel(channelId, patch, this.defaultCwd);
      changed.push(channelId);
    }
    return changed;
  }
}
