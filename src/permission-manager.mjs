import { classifyToolCall } from './policy.mjs';

export const LEVEL = {
  STRICT: 'strict',
  STANDARD: 'standard',
  RELAXED: 'relaxed',
  FULL: 'full',
};

export const LEVEL_LABEL = {
  [LEVEL.STRICT]: '🔒 严格',
  [LEVEL.STANDARD]: '🛡️ 标准',
  [LEVEL.RELAXED]: '⚡ 放宽',
  [LEVEL.FULL]: '🔓 全开放',
};

export const LEVEL_EMOJI = {
  [LEVEL.STRICT]: '🔒',
  [LEVEL.STANDARD]: '🛡️',
  [LEVEL.RELAXED]: '⚡',
  [LEVEL.FULL]: '🔓',
};

/** 默认权限档位。 */
export const DEFAULT_LEVEL = LEVEL.STANDARD;

export class PermissionManager {
  /**
   * `initialLevels` restores owner-selected tiers persisted across a bridge
   * restart. `onChange` persists a new explicit tier; it is a product
   * configuration write, not ephemeral Agent session state, so model/provider/
   * executor/workspace changes and new sessions never trigger it.
   */
  constructor({ defaultLevel = DEFAULT_LEVEL, initialLevels = null, onChange = null } = {}) {
    this.defaultLevel = defaultLevel;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    /** 每个 channel 的当前权限档位。 */
    this.levelByChannel = new Map();
    this.levelBySession = new Map();
    this.channelBySession = new Map();
    if (initialLevels && typeof initialLevels === 'object') {
      for (const [channelId, level] of Object.entries(initialLevels)) {
        if (channelId && Object.values(LEVEL).includes(level)) this.levelByChannel.set(channelId, level);
      }
    }
  }

  /** 获取指定 channel 的当前权限档位。 */
  getLevel(channelId) {
    return this.levelByChannel.get(channelId) || this.defaultLevel;
  }

  /** 获取指定 session 的当前权限档位。 */
  getLevelBySession(sessionId) {
    return this.levelBySession.get(sessionId) || this.defaultLevel;
  }

  /** 将 channel 的权限档位同步到 session（任务开始时调用）。 */
  syncSession(sessionId, channelId) {
    if (!sessionId || !channelId) return;
    this.channelBySession.set(sessionId, channelId);
    const level = this.getLevel(channelId);
    this.levelBySession.set(sessionId, level);
  }

  /** 移除 session 的权限记录。 */
  removeSession(sessionId) {
    this.levelBySession.delete(sessionId);
    this.channelBySession.delete(sessionId);
  }

  /**
   * `meta.explicit` marks an owner-facing choice (switchLevel/confirmFull) as
   * opposed to trusted internal inheritance (inheritLevel): only an explicit
   * choice may become the durable owner default for future scopes.
   */
  #setLevel(channelId, level, meta = {}) {
    this.levelByChannel.set(channelId, level);
    for (const [sessionId, ownerChannelId] of this.channelBySession) {
      if (ownerChannelId === channelId) this.levelBySession.set(sessionId, level);
    }
    try { this.onChange?.(channelId, level, meta); } catch { /* persistence must never break a switch */ }
  }

  /**
   * Reset every in-memory tier to the canonical default. Used by `初始化设置`
   * after the persisted state has already been reset; it never fires `onChange`
   * because the file is authoritative at that point.
   */
  resetAll(defaultLevel = DEFAULT_LEVEL) {
    this.defaultLevel = defaultLevel ?? DEFAULT_LEVEL;
    this.levelByChannel.clear();
    this.levelBySession.clear();
    this.channelBySession.clear();
  }

  /** 切换档位。返回 { ok, previous, current, needsConfirm, changed }。 */
  switchLevel(channelId, level) {
    const previous = this.getLevel(channelId);
    if (!Object.values(LEVEL).includes(level)) {
      return { ok: false, previous, current: previous, needsConfirm: false, changed: false };
    }
    if (previous === level) return { ok: true, previous, current: level, needsConfirm: false, changed: false };

    if (level === LEVEL.FULL) {
      return { ok: false, previous, current: previous, needsConfirm: true, changed: false };
    }

    this.#setLevel(channelId, level, { explicit: true });
    return { ok: true, previous, current: level, needsConfirm: false, changed: true };
  }

  /** 确认 FULL 模式（二次确认后调用）。 */
  confirmFull(channelId) {
    const previous = this.getLevel(channelId);
    this.#setLevel(channelId, LEVEL.FULL, { explicit: true });
    return { ok: true, previous, current: LEVEL.FULL, changed: previous !== LEVEL.FULL };
  }

  /**
   * Trusted internal inheritance for a child channel (e.g. a new Work thread
   * created from a parent). It copies the parent's already-effective level
   * EXACTLY, including FULL, without routing through the owner-facing
   * confirmation. `switchLevel()` deliberately refuses FULL unless confirmed,
   * so using it here silently downgraded a FULL parent's thread to STANDARD.
   * This method must never be reachable from a user-facing switch control.
   */
  inheritLevel(channelId, level) {
    const previous = this.getLevel(channelId);
    if (!Object.values(LEVEL).includes(level)) {
      return { ok: false, previous, current: previous, changed: false };
    }
    this.#setLevel(channelId, level, { explicit: false });
    return { ok: true, previous, current: level, changed: previous !== level };
  }

  /**
   * Clear session-scoped bookkeeping (session → channel maps) without touching
   * the owner's explicit tier. Called by `!reset`, `!cwd`, workspace/provider/
   * model/executor changes and a new Agent session: none of those are a
   * permission decision, so FULL must survive them. Only `switchLevel()` /
   * `confirmFull()` change the persisted tier.
   */
  reset(channelId, reason = 'reset') {
    const previous = this.getLevel(channelId);
    for (const [sessionId, ownerChannelId] of [...this.channelBySession]) {
      if (ownerChannelId === channelId) this.removeSession(sessionId);
    }
    const current = this.getLevel(channelId);
    return { previous, current, changed: previous !== current, reason };
  }

  async classify({ sessionId, ...toolCall }) {
    return classifyToolCall({ ...toolCall, permissionLevel: this.getLevelBySession(sessionId) });
  }

  /** 当前档位是否属于指定档位或更宽松。 */
  isAtLeast(channelId, level) {
    const order = [LEVEL.STRICT, LEVEL.STANDARD, LEVEL.RELAXED, LEVEL.FULL];
    const current = this.getLevel(channelId);
    return order.indexOf(current) >= order.indexOf(level);
  }
}
