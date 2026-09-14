/**
 * PermissionManager — 四档权限系统的唯一真源。
 *
 * STRICT  → 只读 + 安全 git 操作
 * STANDARD→ 工作区读写 + 测试 + 常规 git（默认）
 * RELAXED → 网络 + 安装 + git push
 * FULL    → 普通工具自动通过（安全边界仍然有效）
 *
 * FULL 仅当前 session 生效，reset / change cwd / bridge 重启自动恢复 STANDARD。
 */

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

/** FULL 重置触发条件。 */
const FULL_RESET_TRIGGERS = new Set(['reset', 'cwd', 'restart']);

export class PermissionManager {
  constructor({ defaultLevel = DEFAULT_LEVEL } = {}) {
    this.defaultLevel = defaultLevel;
    /** 每个 channel 的当前权限档位。 */
    this.levelByChannel = new Map();
    /** 每个 session 的当前权限档位（用于 hook server 查询）。 */
    this.levelBySession = new Map();
    /** 每个 channel 是否已确认过 FULL 模式。 */
    this.fullConfirmedByChannel = new Set();
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
    const level = this.getLevel(channelId);
    this.levelBySession.set(sessionId, level);
  }

  /** 移除 session 的权限记录。 */
  removeSession(sessionId) {
    this.levelBySession.delete(sessionId);
  }

  /** 设置指定 channel 的权限档位。 */
  setLevel(channelId, level) {
    if (!Object.values(LEVEL).includes(level)) return false;
    this.levelByChannel.set(channelId, level);
    return true;
  }

  /** 切换档位。返回 { ok, previous, current, needsConfirm, changed }。 */
  switchLevel(channelId, level) {
    const previous = this.getLevel(channelId);
    if (previous === level) return { ok: true, previous, current: level, needsConfirm: false, changed: false };

    if (level === LEVEL.FULL) {
      if (!this.fullConfirmedByChannel.has(channelId)) {
        return { ok: false, previous, current: previous, needsConfirm: true, changed: false };
      }
    }

    this.levelByChannel.set(channelId, level);
    return { ok: true, previous, current: level, needsConfirm: false, changed: true };
  }

  /** 确认 FULL 模式（二次确认后调用）。 */
  confirmFull(channelId) {
    this.fullConfirmedByChannel.add(channelId);
    const previous = this.getLevel(channelId);
    this.levelByChannel.set(channelId, LEVEL.FULL);
    return { ok: true, previous, current: LEVEL.FULL, changed: previous !== LEVEL.FULL };
  }

  /** 重置指定 channel 的权限为默认值（!reset / !cwd / bridge 重启时调用）。 */
  reset(channelId, reason = 'reset') {
    const previous = this.getLevel(channelId);
    this.levelByChannel.delete(channelId);
    this.fullConfirmedByChannel.delete(channelId);
    const current = this.getLevel(channelId);
    return { previous, current, changed: previous !== current, reason };
  }

  /** 当前档位是否属于指定档位或更宽松。 */
  isAtLeast(channelId, level) {
    const order = [LEVEL.STRICT, LEVEL.STANDARD, LEVEL.RELAXED, LEVEL.FULL];
    const current = this.getLevel(channelId);
    return order.indexOf(current) >= order.indexOf(level);
  }
}
