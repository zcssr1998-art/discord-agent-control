// P2.2B: Windows Task Scheduler autostart helpers.
//
// The canonical scheduled task launches THIS checkout's supervisor
// (scripts/start-supervisor.ps1), never node src/index.mjs directly: the
// supervisor remains the only restart owner for the bridge and LiteLLM.
// Query/install/uninstall are deterministic local operations (no LLM, no
// secrets printed).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const AUTOSTART_TASK_NAME = 'Jarvis Discord Agent Control';
export const SUPERVISOR_SCRIPT = path.join('scripts', 'start-supervisor.ps1');

/** Build the scheduled-task action command line for a given checkout root. */
export function buildTaskAction(root) {
  const script = path.join(root, 'scripts', 'start-supervisor.ps1');
  const drive = path.dirname(script).slice(0, 2);
  return `${drive} && cd /d "${path.dirname(script)}" && powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
}

/**
 * Parse `schtasks /query /tn <name> /fo list /v` output into fields we can show.
 * Pure function so it is testable without Windows (key lines only).
 */
export function parseSchtasksInfo(output) {
  const info = { found: false, status: null, taskToRun: null, taskName: null };
  const lines = String(output ?? '').split(/\r?\n/);
  let sawNameLine = false;
  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const k = (key || '').trim().toLowerCase();
    if (k === 'taskname') { info.taskName = value || null; sawNameLine = true; }
    if (k === 'status') info.status = value || null;
    if (k === 'task to run') info.taskToRun = value || null;
  }
  if (sawNameLine || info.status !== null || info.taskToRun !== null) {
    info.found = true;
    return info;
  }
  if (/error: the system cannot find/i.test(String(output ?? ''))) return { found: false, status: 'NOT_FOUND' };
  return info;
}

/** Query the canonical task. Deterministic, never throws for "not found". */
export async function queryAutostartTask({ taskName = AUTOSTART_TASK_NAME } = {}) {
  try {
    const { stdout } = await execFileAsync('schtasks', ['/query', '/tn', taskName, '/fo', 'list', '/v'], { timeout: 15000 });
    const info = parseSchtasksInfo(stdout);
    info.found = true;
    return info;
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    const info = parseSchtasksInfo(stdout || error?.message || '');
    if (info.found) return info;
    return { found: false, status: 'NOT_FOUND', error: String(error?.message || error).slice(0, 160) };
  }
}

/** Compact "enabled/disabled + state" text for /status and /doctor. */
export async function autostartSummary() {
  const task = await queryAutostartTask();
  if (!task.found) return 'disabled (task not installed)';
  const state = (task.status || '?').trim();
  return `enabled · ${state}${task.taskToRun ? '' : ''}`;
}

export default { AUTOSTART_TASK_NAME, buildTaskAction, parseSchtasksInfo, queryAutostartTask, autostartSummary };
