/**
 * P3 TechLead — normalized internal WorkEvent seam.
 *
 * TechLead must not depend on one OpenCode hook API. Existing Jarvis Work
 * lifecycle / runner signals are mapped into a small transport-neutral event
 * representation, and OpenCode structured events are only an enrichment path.
 * Adding a new event type is cheap, so only the ones actually available today
 * are defined.
 */

export const WORK_EVENT = Object.freeze({
  WORK_STARTED: 'WORK_STARTED',
  WORK_PHASE_CHANGED: 'WORK_PHASE_CHANGED',
  TOOL_STARTED: 'TOOL_STARTED',
  TOOL_FINISHED: 'TOOL_FINISHED',
  COMMAND_FAILED: 'COMMAND_FAILED',
  COMMAND_SUCCEEDED: 'COMMAND_SUCCEEDED',
  TEST_RESULT: 'TEST_RESULT',
  FILE_CHANGED: 'FILE_CHANGED',
  WORKER_MESSAGE: 'WORKER_MESSAGE',
  WORKER_PLAN_CHANGED: 'WORKER_PLAN_CHANGED',
  WORK_COMPLETED: 'WORK_COMPLETED',
  WORK_FAILED: 'WORK_FAILED',
  WORK_STOPPED: 'WORK_STOPPED',
});

const WORK_EVENT_TYPES = new Set(Object.values(WORK_EVENT));

export function isWorkEvent(value) {
  return Boolean(value && WORK_EVENT_TYPES.has(value.type));
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Collapse an arbitrary error/tool-result string into a stable signature so the
 * same failure with different timestamps, ids, numbers or absolute paths does
 * not look like a new error.
 */
export function normalizeErrorSignature(text) {
  let value = String(text ?? '').toLowerCase();
  value = value.replace(/\r/g, '');
  value = value.replace(/[a-z]:\\[^\s'"]+/g, '<path>');
  value = value.replace(/(?:\/[\w.-]+){2,}\.[a-z0-9]+/g, '<path>');
  value = value.replace(/0x[0-9a-f]+/g, '0x');
  value = value.replace(/\b[0-9a-f]{7,}\b/g, '#hash');
  value = value.replace(/\b\d+(?:\.\d+)?\b/g, '#');
  value = value.replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, '<ts>');
  value = value.replace(/\s+/g, ' ').trim();
  return clip(value, 180);
}

const TEST_FAIL = /(?:#\s*fail\s+[1-9]|\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing)\b|\bFAILED\b|\bFAIL\b|exit code [1-9])/;
const TEST_PASS = /(?:#\s*pass\s+\d+|\b\d+\s+(?:tests?\s+)?(?:passed|passing)\b|\bPASS\b|exit code 0)/;

/** Deterministic pass/fail extraction from a tool result; null when unknown. */
export function extractTestState(text) {
  const value = String(text ?? '');
  const failed = TEST_FAIL.test(value);
  const passed = TEST_PASS.test(value);
  if (failed && !passed) return 'fail';
  if (passed && !failed) return 'pass';
  if (failed && passed) return 'fail';
  return null;
}

/** A stable, human-visible label for the action behind an event. */
export function actionLabel({ tool = null, command = null, file = null } = {}) {
  if (command) return `cmd:${clip(command, 120)}`;
  if (file) return `file:${clip(file, 120)}`;
  if (tool) return `tool:${clip(tool, 60)}`;
  return 'action';
}

const RISKY_PATTERNS = [
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
  /git\s+push\s+.*--force/i,
  /rm\s+-rf?\s+(?:\/|\*|\.)/i,
  /(?:del|erase)\s+\/[a-z]\s+\/s/i,
  /format\s+[a-z]:/i,
  /reinstall/i,
  /(?:uninstall).*(?:driver|cuda|python|node)/i,
  /drop\s+(?:database|table)/i,
  /chmod\s+777/i,
  /(?:重置|重装|卸载|格式化|删除全部|清空)(?:系统|环境|cuda|驱动|仓库|数据库)?/i,
];

export function looksRisky(text) {
  const value = String(text ?? '');
  return RISKY_PATTERNS.some((pattern) => pattern.test(value));
}

export function classifyAction(tool, command) {
  const name = String(tool ?? '');
  const cmd = String(command ?? '');
  if (/\b(npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|lint|build))\b/i.test(cmd) || /\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i.test(cmd)) return 'TEST';
  if (/^\s*git\b/i.test(cmd)) return 'GIT';
  if (/^(Bash|Shell|PowerShell)$/.test(name)) return 'SHELL';
  if (/^(Write|Edit|NotebookEdit)$/.test(name)) return 'EDIT';
  if (/^(Read|NotebookRead)$/.test(name)) return 'READ';
  if (/^(Glob|Grep|WebSearch)$/.test(name)) return 'SEARCH';
  return name || 'OTHER';
}

/**
 * Map one runner/Jarvis event to a normalized WorkEvent, or null when the event
 * carries no TechLead-relevant signal (session/model/raw noise).
 */
export function toWorkEvent(event, { at = Date.now(), phase = null } = {}) {
  if (!event) return null;
  if (isWorkEvent(event)) return { ...event, at: event.at ?? at };
  const type = String(event.type ?? '');
  if (type === 'tool') {
    const tool = event.tool || {};
    const input = tool.input || {};
    const command = input.command ?? null;
    const file = input.file_path ?? input.notebook_path ?? null;
    const kind = classifyAction(tool.name, command);
    return {
      type: WORK_EVENT.TOOL_STARTED,
      at,
      phase,
      tool: tool.name ?? null,
      command,
      file,
      kind,
      action: actionLabel({ tool: tool.name, command, file }),
    };
  }
  if (type === 'tool-result') {
    const text = String(event.text ?? '');
    const testState = extractTestState(text);
    if (testState) return { type: WORK_EVENT.TEST_RESULT, at, phase, testState, resultText: clip(text, 600) };
    const looksError = /\b(error|failed|exception|traceback|cannot|not found|denied|refused)\b/i.test(text);
    if (looksError) {
      return {
        type: WORK_EVENT.COMMAND_FAILED,
        at,
        phase,
        error: clip(text, 600),
        errorSignature: normalizeErrorSignature(text),
      };
    }
    return { type: WORK_EVENT.TOOL_FINISHED, at, phase, resultText: clip(text, 600) };
  }
  if (type === 'retry') {
    const raw = event.error || `api retry ${event.errorStatus ?? ''}`;
    return {
      type: WORK_EVENT.COMMAND_FAILED,
      at,
      phase,
      error: clip(raw, 300),
      errorSignature: normalizeErrorSignature(raw),
      kind: 'NETWORK',
    };
  }
  if (type === 'text') return { type: WORK_EVENT.WORKER_MESSAGE, at, phase, message: clip(event.text, 800) };
  if (type === 'stderr') return { type: WORK_EVENT.WORKER_MESSAGE, at, phase, stream: 'stderr', message: clip(event.text, 400) };
  if (type === 'init') return { type: WORK_EVENT.WORK_PHASE_CHANGED, at, phase: 'init' };
  return null;
}
