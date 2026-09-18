/**
 * P3 TechLead — Progress Fingerprint.
 *
 * Compact local progress state used to answer one question: "did the task
 * materially progress since the previous incident window?" It is built only
 * from events/state already available, never by recursively scanning the
 * workspace, and only cheap targeted Git output.
 */
import { createHash } from 'node:crypto';
import { WORK_EVENT } from './work-event.mjs';

const MAX_FILES = 20;
const MAX_HISTORY = 6;

export function emptyFingerprint() {
  return {
    changedFiles: [],
    fileChangeCount: 0,
    lastFileChangeAt: null,
    lastAction: null,
    lastActionKind: null,
    lastSuccessAction: null,
    lastErrorSignature: null,
    sameErrorCount: 0,
    sameActionCount: 0,
    testState: null,
    testStateAt: null,
    phase: null,
    evidenceCount: 0,
    actionCount: 0,
    lastEventAt: null,
    history: [],
    planHistory: [],
  };
}

function pushBounded(list, value, max) {
  const next = [...list, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

function addFile(files, file) {
  const value = String(file ?? '').trim();
  if (!value) return files;
  const next = files.includes(value) ? files : [...files, value];
  return next.length > MAX_FILES ? next.slice(next.length - MAX_FILES) : next;
}

/**
 * Produce the next fingerprint for one normalized WorkEvent. Returns a new
 * object; the previous fingerprint is never mutated.
 *
 * Optional `evidence` ({ changedFiles, testState, phase, action }) lets the UI
 * merge cheap Git/process evidence without inventing new event types.
 */
export function applyEvent(previous, event, { evidence = null } = {}) {
  const prev = previous ?? emptyFingerprint();
  const next = { ...prev, changedFiles: [...prev.changedFiles], history: [...prev.history] };
  const at = event?.at ?? Date.now();
  next.lastEventAt = at;

  if (evidence?.changedFiles?.length) {
    for (const file of evidence.changedFiles) next.changedFiles = addFile(next.changedFiles, file);
    next.fileChangeCount += evidence.changedFiles.length;
    next.lastFileChangeAt = at;
  }

  const type = event?.type;

  if (type === WORK_EVENT.FILE_CHANGED) {
    for (const file of event.files ?? [event.file]) next.changedFiles = addFile(next.changedFiles, file);
    next.fileChangeCount += (event.files?.length || (event.file ? 1 : 0));
    next.lastFileChangeAt = at;
    next.evidenceCount += 1;
    // New evidence breaks the "same failure loop".
    next.sameErrorCount = 0;
  } else if (type === WORK_EVENT.TOOL_STARTED) {
    const action = event.action ?? event.tool ?? 'action';
    next.lastAction = action;
    next.lastActionKind = event.kind ?? null;
    next.actionCount += 1;
    next.sameActionCount = prev.lastAction === action ? prev.sameActionCount + 1 : 1;
    next.history = pushBounded(next.history, action, MAX_HISTORY);
  } else if (type === WORK_EVENT.TOOL_FINISHED) {
    next.lastSuccessAction = prev.lastAction ?? prev.lastSuccessAction;
    next.evidenceCount += 1;
    if (event.resultText) next.lastEvidence = String(event.resultText).slice(0, 200);
    if (prev.sameErrorCount && prev.lastErrorSignature) {
      // A clean finish breaks the failure streak without inventing progress.
      next.sameErrorCount = 0;
    }
  } else if (type === WORK_EVENT.COMMAND_SUCCEEDED) {
    next.lastSuccessAction = event.action ?? prev.lastAction ?? prev.lastSuccessAction;
    next.evidenceCount += 1;
    next.sameErrorCount = 0;
  } else if (type === WORK_EVENT.COMMAND_FAILED) {
    const signature = event.errorSignature ?? 'unknown';
    next.lastErrorSignature = signature;
    next.sameErrorCount = prev.lastErrorSignature === signature ? prev.sameErrorCount + 1 : 1;
    next.lastFailureAction = prev.lastAction ?? event.action ?? null;
  } else if (type === WORK_EVENT.TEST_RESULT) {
    next.testState = event.testState ?? null;
    next.testStateAt = at;
    next.evidenceCount += 1;
    if (next.testState === 'pass') next.sameErrorCount = 0;
  } else if (type === WORK_EVENT.WORKER_MESSAGE) {
    next.lastWorkerMessage = String(event.message ?? '').slice(0, 300);
    next.evidenceCount += 1;
  } else if (type === WORK_EVENT.WORKER_PLAN_CHANGED) {
    next.plan = event.plan ?? null;
    next.planChanges = (prev.planChanges ?? 0) + 1;
    next.planHistory = pushBounded(prev.planHistory ?? [], next.plan, MAX_HISTORY);
  } else if (type === WORK_EVENT.WORK_PHASE_CHANGED) {
    next.phase = event.phase ?? null;
  } else if (type === WORK_EVENT.WORK_STARTED) {
    if (event.phase) next.phase = event.phase;
  }

  if (event?.phase) next.phase = event.phase;
  if (evidence?.phase) next.phase = evidence.phase;
  if (evidence?.testState) { next.testState = evidence.testState; next.testStateAt = at; }
  if (evidence?.action) next.lastSuccessAction = evidence.action;

  return next;
}

/** Stable hash of the "material" fingerprint fields, for dedupe signatures. */
export function materialHash(fingerprint) {
  const fp = fingerprint ?? emptyFingerprint();
  const material = [
    fp.fileChangeCount,
    fp.testState,
    fp.phase,
    fp.evidenceCount,
    fp.lastSuccessAction ?? '',
    (fp.changedFiles ?? []).join(','),
  ].join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

/**
 * Did the task materially progress between two fingerprints? A repeated action
 * alone is never progress; new files, new successful action, a changed
 * test/phase state or new evidence count as progress.
 */
export function materialProgress(previous, next) {
  const prev = previous ?? emptyFingerprint();
  const now = next ?? emptyFingerprint();
  const reasons = [];
  const prevFiles = new Set(prev.changedFiles ?? []);
  if ((now.changedFiles ?? []).some((file) => !prevFiles.has(file))) reasons.push('new-file-change');
  if ((now.fileChangeCount ?? 0) > (prev.fileChangeCount ?? 0)) reasons.push('file-change-count');
  if ((now.evidenceCount ?? 0) > (prev.evidenceCount ?? 0)) reasons.push('new-evidence');
  if ((now.testState ?? null) !== (prev.testState ?? null)) reasons.push('test-state');
  if ((now.phase ?? null) !== (prev.phase ?? null)) reasons.push('phase');
  if ((now.lastSuccessAction ?? null) !== (prev.lastSuccessAction ?? null)) reasons.push('new-success-action');
  return { changed: reasons.length > 0, reasons };
}

export function summarizeFingerprint(fingerprint) {
  const fp = fingerprint ?? emptyFingerprint();
  return {
    changedFiles: fp.changedFiles,
    fileChangeCount: fp.fileChangeCount,
    lastAction: fp.lastAction,
    lastSuccessAction: fp.lastSuccessAction,
    lastErrorSignature: fp.lastErrorSignature,
    sameErrorCount: fp.sameErrorCount,
    sameActionCount: fp.sameActionCount,
    testState: fp.testState,
    phase: fp.phase,
    evidenceCount: fp.evidenceCount,
    materialHash: materialHash(fp),
  };
}
