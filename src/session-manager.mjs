export class SessionManager {
  constructor({ state, permissionManager, approvalManager, defaultCwd, stopRunner = async () => {}, isRunning = () => false }) {
    this.state = state;
    this.permissions = permissionManager;
    this.approvals = approvalManager;
    this.defaultCwd = defaultCwd;
    this.stopRunner = stopRunner;
    this.isRunning = isRunning;
  }

  get(channelId) {
    return {
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

  bindExecutorSession(channelId, executorSessionId) {
    this.state.patchChannel(channelId, { sessionId: executorSessionId }, this.defaultCwd);
    this.permissions.syncSession(executorSessionId, channelId);
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
      .filter(([, value]) => value.providerId === providerId)
      .map(([channelId]) => channelId);
    if (channels.some((channelId) => this.isRunning(channelId))) {
      throw Object.assign(new Error('task is running'), { code: 'RUNNING' });
    }
    const changed = [];
    for (const channelId of channels) {
      await this.change(channelId, { providerId: null, model: null }, 'provider removed');
      changed.push(channelId);
    }
    return changed;
  }
}
