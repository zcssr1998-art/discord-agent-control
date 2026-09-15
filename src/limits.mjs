/**
 * Runaway protection.
 *
 * A remote agent that keeps failing, restarting or looping will burn tokens in
 * the background where nobody is watching. Every one of those paths gets an
 * explicit cap here, and hitting a cap stops the run instead of retrying.
 */

/** Reject with a TimeoutError if `promise` does not settle in time. */
export function withTimeout(promise, ms, { onTimeout = null, label = 'operation' } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the caller's cleanup must not mask the timeout */ }
      const error = new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was stopped`);
      error.code = 'TASK_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RunLimits {
  constructor({ maxConsecutiveFailures = 3, maxProcessRestarts = 5 } = {}) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.maxProcessRestarts = maxProcessRestarts;
    this.channels = new Map();
  }

  #state(channelId) {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, { consecutiveFailures: 0, restarts: 0, lastError: null });
    }
    return this.channels.get(channelId);
  }

  noteSuccess(channelId) {
    const s = this.#state(channelId);
    s.consecutiveFailures = 0;
    s.lastError = null;
  }

  noteFailure(channelId, error) {
    const s = this.#state(channelId);
    s.consecutiveFailures += 1;
    s.lastError = String(error?.message || error || 'unknown error');
    return s.consecutiveFailures;
  }

  noteProcessRestart(channelId) {
    return (this.#state(channelId).restarts += 1);
  }

  /** Refuse to start more work once a channel is clearly stuck. */
  blocked(channelId) {
    const s = this.#state(channelId);
    if (s.consecutiveFailures >= this.maxConsecutiveFailures) {
      return {
        blocked: true,
        reason: `连续失败 ${s.consecutiveFailures} 次（上限 ${this.maxConsecutiveFailures}）。`
          + `最近错误：${s.lastError}。修复原因后发送 \`!reset\` 清零。`,
      };
    }
    if (s.restarts >= this.maxProcessRestarts) {
      return {
        blocked: true,
        reason: `Agent 进程已重启 ${s.restarts} 次（上限 ${this.maxProcessRestarts}）。发送 \`!reset\` 清零。`,
      };
    }
    return { blocked: false, reason: null };
  }

  reset(channelId) {
    this.channels.delete(channelId);
  }

  snapshot(channelId) {
    return { ...this.#state(channelId) };
  }
}
