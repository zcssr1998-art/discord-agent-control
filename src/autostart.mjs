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

/**
 * Build the scheduled-task action command line for a given checkout root.
 *
 * Native PowerShell action (no cmd.exe hop): the supervisor becomes the task's
 * top-level process, so the Task Scheduler restart-on-failure policy observes
 * its exit directly. The installer sets the working directory separately.
 */
export function buildTaskAction(root) {
  const script = path.join(root, 'scripts', 'start-supervisor.ps1');
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
}

/**
 * Parse `schtasks /query /tn <name> /fo list /v` output into fields we can show.
 * Pure function so it is testable without Windows (key lines only).
 *
 * P0: `schtasks` localises its key names (Chinese Windows emits Chinese keys
 * in GBK, which Node decodes as mojibake). English keys are matched exactly;
 * anything carrying the supervisor script path or a powershell action is also
 * accepted as a task-action line so a localised listing is still recognised
 * as "found" instead of misreported as "not installed".
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
    // Localised fallback: the action line is the only one that names the
    // supervisor script. Accept it even when the key itself is unreadable.
    if (!info.taskToRun && /start-supervisor\.ps1/i.test(line) && /powershell/i.test(line)) {
      const m = line.match(/powershell\.exe.*start-supervisor\.ps1.*/i);
      if (m) info.taskToRun = m[0].trim();
      else if (value) info.taskToRun = value;
      sawNameLine = true;
    }
  }
  if (sawNameLine || info.status !== null || info.taskToRun !== null) {
    info.found = true;
    return info;
  }
  if (/error: the system cannot find/i.test(String(output ?? ''))) return { found: false, status: 'NOT_FOUND' };
  return info;
}

/**
 * Parse `Get-ScheduledTask -TaskName <name> | Select ... | ConvertTo-Json`.
 * Locale-independent (property names are always English). Pure for tests.
 */
export function parseScheduledTaskJson(raw) {
  let data = null;
  try { data = JSON.parse(String(raw ?? '').trim()); }
  catch { return { found: false, status: 'NOT_FOUND' }; }
  if (!data || typeof data !== 'object') return { found: false, status: 'NOT_FOUND' };
  const action = Array.isArray(data.Actions) ? data.Actions[0] : data.Actions;
  const taskToRun = action
    ? `${action.Execute ?? ''} ${action.Arguments ?? ''}`.trim() || null
    : null;
  // Get-ScheduledTask State serialises as a TaskState enum integer over JSON
  // (0 Unknown, 1 Disabled, 2 Queued, 3 Ready, 4 Running). Map it so status
  // output stays human-readable and locale-independent.
  const STATE_NAMES = { 0: 'Unknown', 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };
  const status = typeof data.State === 'number' ? (STATE_NAMES[data.State] ?? String(data.State)) : (data.State || null);
  return {
    found: true,
    status,
    taskToRun,
    taskName: data.TaskName || null,
  };
}

/**
 * True when the installed task action launches `root`'s supervisor.
 * Case- and slash-insensitive so `C:/x` and `c:\\x` compare equal.
 */
export function isTaskActionForRoot(taskToRun, root) {
  const action = String(taskToRun ?? '');
  const base = String(root ?? '');
  if (!action || !base) return false;
  const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();
  if (!/start-supervisor\.ps1/i.test(action)) return false;
  return norm(action).includes(norm(base));
}

/** Query the canonical task. Deterministic, never throws for "not found". */
export async function queryAutostartTask({ taskName = AUTOSTART_TASK_NAME } = {}) {
  // Primary on Windows: locale-independent object query.
  if (process.platform === 'win32') {
    try {
      const ps = 'Get-ScheduledTask -TaskName $env:JARVIS_TASK_NAME | Select-Object TaskName,State,@{n=\'Actions\';e={$_.Actions}} | ConvertTo-Json -Compress -Depth 4';
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
      ], { timeout: 15000, env: { ...process.env, JARVIS_TASK_NAME: taskName } });
      const info = parseScheduledTaskJson(stdout);
      if (info.found) return info;
    } catch { /* fall through to schtasks */ }
  }
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

/**
 * Detailed autostart state for /doctor. `root` (the live checkout) enables
 * the "task points elsewhere" warning; without it only presence/state show.
 */
export async function autostartDetailedStatus({ root = null } = {}) {
  const task = await queryAutostartTask();
  if (!task.found) return { ...task, pointsToCurrentCheckout: false, summary: 'disabled (task not installed)' };
  const state = String(task.status || '?').trim();
  const enabled = !/disabled|not_found/i.test(state);
  const points = root ? isTaskActionForRoot(task.taskToRun, root) : true;
  const where = points ? '' : ' · WARNING: task action points to a different checkout';
  const summary = `${enabled ? 'enabled' : 'DISABLED'} · ${state}${where}`;
  return { ...task, enabled, pointsToCurrentCheckout: points, summary };
}

/** Compact "enabled/disabled + state" text for /status and /doctor. */
export async function autostartSummary({ root = null } = {}) {
  try {
    const detailed = await autostartDetailedStatus({ root });
    return detailed.summary;
  } catch {
    return 'unknown';
  }
}

export default {
  AUTOSTART_TASK_NAME, buildTaskAction, parseSchtasksInfo, parseScheduledTaskJson,
  isTaskActionForRoot, queryAutostartTask, autostartSummary, autostartDetailedStatus,
};
