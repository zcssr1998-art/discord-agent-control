/**
 * EventPresenter — 可观测执行过程。
 *
 * 将 stream-json 事件和工具调用转换为本地的中文执行状态，
 * 不额外调用 LLM，Prompt Token = 0，Output Token = 0。
 */

import { describeTool, STATE_LABEL, shorten, redact } from './i18n.mjs';

export const STATE = {
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  RUNNING: 'RUNNING',
  TESTING: 'TESTING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  DONE: 'DONE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${String(s % 60).padStart(2, '0')}秒`;
}

/** 渲染最近操作列表为树形结构。 */
function renderRecent(actions, max = 6) {
  if (!actions.length) return '';
  const kept = actions.slice(-max);
  const lines = kept.map((a, i) => {
    const prefix = i === kept.length - 1 ? '└─' : '├─';
    return `${prefix} ${a}`;
  });
  return ['⚡ 最近操作', ...lines].join('\n');
}

/**
 * 单个任务的可观测状态。
 *
 * 所有展示信息从本地事件流生成，不调用模型。
 */
export class TaskProgress {
  constructor({ cwd, startedAt = Date.now(), maxRecent = 6 } = {}) {
    this.cwd = cwd;
    this.startedAt = startedAt;
    this.maxRecent = maxRecent;
    this.state = STATE.CREATED;
    this.lastAction = null;
    this.recent = [];
    this.toolCounts = new Map();
    this.tests = null;
    this.approval = null;
    this.note = null;
    this.retry = null;
    this.stall = null;
    this.lastTool = null;
    this.permissionLabel = '🛡️ 标准';
  }

  markStalled(idleMs) {
    this.stall = { idleMs, tool: this.lastTool };
    return this;
  }

  clearStall() {
    this.stall = null;
    return this;
  }

  recordRetry({ attempt, maxRetries, errorStatus, error } = {}) {
    this.retry = { attempt, maxRetries, errorStatus, error };
    this.state = STATE.RUNNING;
    this.stall = null;
    return this;
  }

  setState(state, note = null) {
    this.state = state;
    if (note !== undefined) this.note = note;
    return this;
  }

  setPermissionLabel(label) {
    this.permissionLabel = label;
    return this;
  }

  setApproval(req) {
    this.state = STATE.WAITING_APPROVAL;
    this.approval = req
      ? { toolName: req.toolName, reason: redact(req.reason) }
      : null;
    return this;
  }

  clearApproval(decision) {
    this.approval = null;
    this.state = STATE.RUNNING;
    this.note = decision === 'allow' ? '已授权' : '已拒绝';
    return this;
  }

  recordTool(tool) {
    const name = tool?.name || 'Tool';
    this.toolCounts.set(name, (this.toolCounts.get(name) || 0) + 1);
    const action = describeTool(name, tool?.input);
    this.lastAction = action;
    this.lastTool = name;
    this.recent.push(action);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }
    this.retry = null;
    this.stall = null;

    if (this.state === STATE.CREATED || this.state === STATE.PLANNING) {
      this.state = STATE.RUNNING;
    }

    const isTest = name === 'Bash' && /^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|check|build))\b/i.test(String(tool?.input?.command || ''));
    if (isTest) {
      this.state = STATE.TESTING;
      this.tests = '运行中';
    } else if (this.state === STATE.TESTING) {
      this.state = STATE.RUNNING;
    }
    return this;
  }

  recordText(text) {
    const t = String(text || '');
    const fail = t.match(/#\s*fail\s+(\d+)/i) || t.match(/(\d+)\s+failed/i);
    const pass = t.match(/#\s*pass\s+(\d+)/i) || t.match(/(\d+)\s+passed/i);
    if (fail && Number(fail[1]) > 0) this.tests = `失败 ${fail[1]}`;
    else if (pass) this.tests = `通过 ${pass[1]}`;
    if (fail || pass) this.state = STATE.RUNNING;
    this.stall = null;
    return this;
  }

  render() {
    const lines = [];
    const duration = formatDuration(Date.now() - this.startedAt);
    lines.push(`${STATE_LABEL[this.state] ?? this.state} · ${duration}`);
    lines.push('');
    lines.push(`📁 当前项目：\`${this.cwd}\``);
    lines.push(`🔐 权限：${this.permissionLabel}`);

    if (this.approval) {
      lines.push('');
      lines.push(`🔐 等待授权：${this.approval.toolName}`);
      lines.push(`原因：${shorten(this.approval.reason, 120)}`);
    } else if (this.retry) {
      lines.push('');
      lines.push(`⚠️ 模型请求重试 ${this.retry.attempt ?? '?'}/${this.retry.maxRetries ?? '?'} (${this.retry.errorStatus ?? 'error'})`);
    }

    if (this.lastAction && !this.approval) {
      lines.push('');
      lines.push(`⚡ 最近操作：${this.lastAction}`);
    }

    if (this.stall && !this.approval) {
      const who = this.stall.tool || 'Agent';
      lines.push(`⏳ 仍在等待 ${who} …（已 ${formatDuration(this.stall.idleMs)} 无新事件）`);
    }

    const recentBlock = renderRecent(this.recent);
    if (recentBlock && this.recent.length > 1) {
      lines.push('');
      lines.push(recentBlock);
    }

    if (this.tests) {
      lines.push('');
      lines.push(`🧪 测试：${this.tests}`);
    }

    if (this.toolCounts.size) {
      const summary = [...this.toolCounts.entries()]
        .map(([k, v]) => `${k}×${v}`)
        .join(' · ');
      lines.push(`🛠️ 工具调用：${shorten(summary, 180)}`);
    }

    if (this.note && !this.approval) {
      lines.push(`💬 ${shorten(this.note, 120)}`);
    }

    return lines.join('\n');
  }
}

/** 节流编辑器：最多每 intervalMs 刷新一次 Discord 消息。 */
export class ThrottledEditor {
  constructor({ intervalMs = 1500, write, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.intervalMs = intervalMs;
    this.write = write;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.timer = null;
    this.pending = null;
    this.writes = 0;
  }

  submit(text) {
    this.pending = text;
    const elapsed = this.now() - this.lastAt;
    if (elapsed >= this.intervalMs) return this.#flush();
    if (!this.timer) {
      this.timer = this.setTimer(() => { this.timer = null; this.#flush(); }, this.intervalMs - elapsed);
    }
    return Promise.resolve();
  }

  async #flush() {
    if (this.pending == null) return;
    const text = this.pending;
    this.pending = null;
    this.lastAt = this.now();
    this.writes += 1;
    try { await this.write(text); } catch { /* message may have been deleted */ }
  }

  async flushNow(text) {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (text != null) this.pending = text;
    this.lastAt = 0;
    await this.#flush();
  }

  dispose() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }
}
