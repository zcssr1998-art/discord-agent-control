import { isTestCommand } from './policy.mjs';

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

const STATE_LABEL = {
  [STATE.CREATED]: '🆕 TASK CREATED',
  [STATE.PLANNING]: '🧠 PLANNING',
  [STATE.RUNNING]: '🟡 RUNNING',
  [STATE.TESTING]: '🧪 TESTING',
  [STATE.WAITING_APPROVAL]: '🔐 WAITING_APPROVAL',
  [STATE.DONE]: '✅ DONE',
  [STATE.FAILED]: '❌ FAILED',
  [STATE.CANCELLED]: '⛔ CANCELLED',
};

function clip(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** One short, human-readable line describing a tool call. */
export function describeToolCall(tool) {
  const input = tool?.input || {};
  switch (tool?.name) {
    case 'Read':
    case 'NotebookRead':
      return `Read ${clip(input.file_path || input.notebook_path || '', 70)}`;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool.name} ${clip(input.file_path || input.notebook_path || '', 70)}`;
    case 'Bash':
      return `Bash: ${clip(input.command || '', 70)}`;
    case 'Glob':
    case 'Grep':
      return `${tool.name} ${clip(input.pattern || '', 50)}`;
    case 'WebFetch':
    case 'WebSearch':
      return `${tool.name} ${clip(input.url || input.query || '', 50)}`;
    default:
      return `${tool?.name || 'Tool'}`;
  }
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Renders the single live Discord status message.
 *
 * Deliberately low-noise: one editable message per task, a fixed state label,
 * the last action, a tool histogram and test status. Raw Claude stdout is never
 * rendered here — it goes to the run log file instead.
 */
export class TaskProgress {
  constructor({ cwd, startedAt = Date.now(), maxRecent = 3 } = {}) {
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
    // Set by the control-plane watchdog when the agent stops producing events.
    // Rendered so a wedged tool call is visible on the phone instead of the
    // status message sitting on a stale "Last action" forever.
    this.stall = null;
    this.lastTool = null;
  }

  /**
   * Mark the run as producing no output for `idleMs`.
   *
   * Deliberately does NOT touch the model or the agent process — the watchdog
   * must never spend tokens, it only repaints the existing status message.
   */
  markStalled(idleMs) {
    this.stall = { idleMs, tool: this.lastTool };
    return this;
  }

  clearStall() {
    this.stall = null;
    return this;
  }

  /**
   * The agent is retrying a failed model request (up to 10 times with
   * exponential backoff = minutes of silence). Without this the phone shows a
   * frozen status and the run looks hung.
   */
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

  setApproval(req) {
    this.state = STATE.WAITING_APPROVAL;
    this.approval = req ? { toolName: req.toolName, reason: req.reason } : null;
    return this;
  }

  clearApproval(decision) {
    this.approval = null;
    this.state = STATE.RUNNING;
    this.note = `approval: ${decision}`;
    return this;
  }

  recordTool(tool) {
    const name = tool?.name || 'Tool';
    this.toolCounts.set(name, (this.toolCounts.get(name) || 0) + 1);
    const action = describeToolCall(tool);
    this.lastAction = action;
    this.lastTool = name;
    this.recent.push(action);
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent);
    this.retry = null;
    this.stall = null;

    if (this.state === STATE.CREATED || this.state === STATE.PLANNING) this.state = STATE.RUNNING;

    const isTest = name === 'Bash' && isTestCommand(tool?.input?.command);
    if (isTest) {
      this.state = STATE.TESTING;
      this.tests = 'running';
    } else if (this.state === STATE.TESTING) {
      // Any non-test action means the test phase is over; without this the status
      // stayed stuck on TESTING while the agent moved on to git work.
      this.state = STATE.RUNNING;
    }
    return this;
  }

  /** Look for a test summary in free text (e.g. "# pass 10 / # fail 0"). */
  recordText(text) {
    const t = String(text || '');
    const fail = t.match(/#\s*fail\s+(\d+)/i) || t.match(/(\d+)\s+failed/i);
    const pass = t.match(/#\s*pass\s+(\d+)/i) || t.match(/(\d+)\s+passed/i);
    if (fail && Number(fail[1]) > 0) this.tests = `failed (${fail[1]})`;
    else if (pass) this.tests = `passed (${pass[1]})`;
    if (fail || pass) this.state = STATE.RUNNING;
    this.stall = null;
    return this;
  }

  render() {
    const lines = [`${STATE_LABEL[this.state]} · ${formatDuration(Date.now() - this.startedAt)}`];
    lines.push(`Project: \`${this.cwd}\``);

    if (this.approval) {
      lines.push(`Waiting for: **${this.approval.toolName}**`);
      lines.push(`Reason: ${clip(this.approval.reason, 120)}`);
    } else if (this.retry) {
      lines.push(`⚠️ Model request retry ${this.retry.attempt ?? '?'}/${this.retry.maxRetries ?? '?'} (${this.retry.errorStatus ?? 'error'}${this.retry.error ? ` ${this.retry.error}` : ''})`);
    } else if (this.lastAction) {
      lines.push(`Last action: ${this.lastAction}`);
    }
    if (this.stall && !this.approval) {
      const who = this.stall.tool || 'Agent';
      lines.push(`⏳ 仍在等待 ${who} …（已 ${formatDuration(this.stall.idleMs)} 无新事件）`);
    }
    if (this.tests) lines.push(`Tests: ${this.tests}`);
    if (this.toolCounts.size) {
      const summary = [...this.toolCounts.entries()].map(([k, v]) => `${k} ×${v}`).join(' · ');
      lines.push(`Tools: ${clip(summary, 180)}`);
    }
    if (this.note && !this.approval) lines.push(`Note: ${clip(this.note, 120)}`);
    return lines.join('\n');
  }
}

/** Throttled editor: at most one Discord message edit per `intervalMs`. */
export class ThrottledEditor {
  constructor({ intervalMs = 1500, write, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.intervalMs = intervalMs;
    this.write = write;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    // Negative infinity so the very first submit always renders immediately.
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

  /** Force the final write through, cancelling any pending throttle timer. */
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
