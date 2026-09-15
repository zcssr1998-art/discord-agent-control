import { isTestCommand } from './policy.mjs';
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
  TIMEOUT: 'TIMEOUT',
};

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${String(s % 60).padStart(2, '0')}秒`;
}

/** 保留旧 API：英文工具描述。 */
export function describeToolCall(tool) {
  const input = tool?.input || {};
  switch (tool?.name) {
    case 'Read':
    case 'NotebookRead':
      return `Read ${shorten(input.file_path || input.notebook_path || '', 70)}`;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool.name} ${shorten(input.file_path || input.notebook_path || '', 70)}`;
    case 'Bash':
      return `Bash: ${shorten(input.command || '', 70)}`;
    case 'Glob':
    case 'Grep':
      return `${tool.name} ${shorten(input.pattern || '', 50)}`;
    case 'WebFetch':
    case 'WebSearch':
      return `${tool.name} ${shorten(input.url || input.query || '', 50)}`;
    default:
      return `${tool?.name || 'Tool'}`;
  }
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

export class TaskProgress {
  constructor({ cwd, startedAt = Date.now(), maxRecent = 6, model = 'unknown', costUsd = 0 } = {}) {
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
    this.model = model;
    this.costUsd = costUsd;
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
    this.retry = { attempt, maxRetries, errorStatus, error: redact(error) };
    this.state = STATE.RUNNING;
    this.stall = null;
    return this;
  }

  setState(state, note = null) {
    this.state = state;
    if (note !== undefined) this.note = redact(note);
    return this;
  }

  setModel(model) {
    this.model = model || 'unknown';
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

    const isTest = name === 'Bash' && isTestCommand(tool?.input?.command);
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
    lines.push(`🤖 模型：${this.model}`);
    lines.push(`💰 成本：$${Number(this.costUsd || 0)}`);

    if (this.approval) {
      lines.push('');
      lines.push(`🔐 等待授权：${this.approval.toolName}`);
      lines.push(`原因：${shorten(this.approval.reason, 120)}`);
    } else if (this.retry) {
      lines.push('');
      lines.push(`⚠️ 模型请求重试 ${this.retry.attempt ?? '?'}/${this.retry.maxRetries ?? '?'} (${this.retry.errorStatus ?? 'error'})`);
    }

    if (!this.approval) {
      lines.push('');
      lines.push('🧠 当前状态');
      lines.push(this.lastAction || '正在分析任务');
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
      const total = [...this.toolCounts.values()].reduce((sum, count) => sum + count, 0);
      lines.push(`🛠️ 工具调用：${total}`);
    }

    if (this.note && !this.approval) {
      lines.push(`💬 ${shorten(this.note, 120)}`);
    }

    return lines.join('\n');
  }
}

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
