/**
 * P3 TechLead — incident detection.
 *
 * Deterministic checks first. The detector never wakes TechLead merely because
 * an action repeats: a stagnation-style incident requires a combination of
 * repeated action, the same normalized failure, no new evidence and no material
 * progress. Thresholds are conservative and configurable.
 */
import { WORK_EVENT, looksRisky, normalizeErrorSignature } from './work-event.mjs';
import { materialProgress, summarizeFingerprint } from './progress-fingerprint.mjs';

export const INCIDENT_CLASS = Object.freeze({
  STAGNATION: 'STAGNATION',
  PLAN_THRASH: 'PLAN_THRASH',
  SCOPE_DRIFT: 'SCOPE_DRIFT',
  RISKY_NEXT_ACTION: 'RISKY_NEXT_ACTION',
  REPEATED_TEST_FAILURE: 'REPEATED_TEST_FAILURE',
  COMPLETION_REVIEW_NEEDED: 'COMPLETION_REVIEW_NEEDED',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  stagnationRepeats: 3,
  planThrashFlips: 3,
  repeatedTestFailures: 2,
  // Directories/paths a normal task in this repository is expected to touch.
  // SCOPE_DRIFT only fires when the contract named a scope and a change lands
  // outside both that scope and these broadly expected locations.
  commonScope: ['src', 'tests', 'scripts', 'docs', 'package.json', 'README.md', '.opencode'],
});

function incident(incidentClass, fields = {}) {
  return {
    class: incidentClass,
    at: fields.at ?? Date.now(),
    action: fields.action ?? null,
    errorSignature: fields.errorSignature ?? null,
    fingerprint: fields.fingerprint ?? null,
    evidence: fields.evidence ?? [],
    proposedAction: fields.proposedAction ?? null,
  };
}

function isOutsideScope(file, contract, commonScope) {
  const value = String(file ?? '').replace(/\\/g, '/').toLowerCase();
  if (!value) return false;
  const scopes = [...(contract?.scope ?? []), ...(contract?.watch ?? [])]
    .map((entry) => String(entry).replace(/\\/g, '/').toLowerCase())
    .filter(Boolean);
  if (scopes.some((scope) => value.includes(scope) || scope.includes(value))) return false;
  return !commonScope.some((prefix) => value.startsWith(prefix));
}

export class IncidentDetector {
  constructor({ thresholds = {}, now = () => Date.now() } = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.now = now;
    this.this_previousFingerprint = null;
  }

  /**
   * Observe one event. Returns an incident or null. `previousFingerprint` is the
   * fingerprint BEFORE `event` was applied; `fingerprint` is AFTER.
   */
  observe({ event, fingerprint, previousFingerprint, contract = null, proposedNextAction = null }) {
    if (!event) return null;
    const at = event.at ?? this.now();
    const type = event.type;
    const fp = fingerprint ?? null;
    const progress = materialProgress(previousFingerprint, fp);
    const summary = summarizeFingerprint(fp);

    // 4. RISKY_NEXT_ACTION — announced/intended high-blast-radius action.
    const intentText = [
      proposedNextAction,
      event.type === WORK_EVENT.WORKER_MESSAGE ? event.message : null,
      event.type === WORK_EVENT.TOOL_STARTED && event.kind === 'SHELL' ? event.command : null,
    ].filter(Boolean).join('\n');
    if (intentText && looksRisky(intentText)) {
      return incident(INCIDENT_CLASS.RISKY_NEXT_ACTION, {
        at,
        action: event.action ?? summary.lastAction,
        evidence: [`risky intent: ${String(intentText).slice(0, 160)}`],
        proposedAction: intentText.slice(0, 300),
        fingerprint: summary,
      });
    }

    // 3. SCOPE_DRIFT — only when a scope was named, on a material file change.
    if (type === WORK_EVENT.FILE_CHANGED) {
      const files = event.files ?? [event.file].filter(Boolean);
      const drifted = files.filter((file) => isOutsideScope(file, contract, this.thresholds.commonScope));
      if (drifted.length && (contract?.scope?.length || contract?.watch?.length)) {
        return incident(INCIDENT_CLASS.SCOPE_DRIFT, {
          at,
          action: `file:${drifted[0]}`,
          evidence: drifted.slice(0, 5),
          fingerprint: summary,
        });
      }
    }

    // 2. PLAN_THRASH — repeated approach flips without measurable progress.
    if (type === WORK_EVENT.WORKER_PLAN_CHANGED) {
      const planHistory = fp?.planHistory ?? [];
      const planChanges = fp?.planChanges ?? 0;
      const distinct = new Set(planHistory.slice(-this.thresholds.planThrashFlips));
      if (planChanges >= this.thresholds.planThrashFlips
        && distinct.size >= this.thresholds.planThrashFlips
        && !progress.changed) {
        return incident(INCIDENT_CLASS.PLAN_THRASH, {
          at,
          action: summary.lastAction,
          evidence: [...distinct].slice(0, this.thresholds.planThrashFlips),
          fingerprint: summary,
        });
      }
    }

    // 5. REPEATED_TEST_FAILURE — same deterministic failure repeats after repair.
    // The failing test result itself is the evidence, so this does not also
    // require "no progress since the last event".
    if (fp?.testState === 'fail'
      && (fp?.sameErrorCount ?? 0) >= this.thresholds.repeatedTestFailures) {
      return incident(INCIDENT_CLASS.REPEATED_TEST_FAILURE, {
        at,
        action: summary.lastAction,
        errorSignature: fp.lastErrorSignature,
        evidence: [`test=${fp.testState}`, `sameErrorCount=${fp.sameErrorCount}`],
        fingerprint: summary,
      });
    }

    // 1. STAGNATION — repeated action + same failure + no new evidence/progress.
    if (type === WORK_EVENT.COMMAND_FAILED
      && (fp?.sameActionCount ?? 0) >= this.thresholds.stagnationRepeats
      && (fp?.sameErrorCount ?? 0) >= this.thresholds.stagnationRepeats
      && !progress.changed) {
      return incident(INCIDENT_CLASS.STAGNATION, {
        at,
        action: summary.lastAction,
        errorSignature: fp.lastErrorSignature,
        evidence: [
          `sameActionCount=${fp.sameActionCount}`,
          `sameErrorCount=${fp.sameErrorCount}`,
          `sameError=${normalizeErrorSignature(fp.lastErrorSignature)}`,
        ],
        fingerprint: summary,
      });
    }

    // 6. COMPLETION_REVIEW_NEEDED — subjective/high-risk acceptance only. Never
    // for a deterministic PASS.
    if (type === WORK_EVENT.WORK_COMPLETED
      && (contract?.subjectiveAcceptance || contract?.risk === 'high')) {
      return incident(INCIDENT_CLASS.COMPLETION_REVIEW_NEEDED, {
        at,
        action: 'work-completed',
        evidence: [`risk=${contract?.risk ?? 'unknown'}`, `subjective=${Boolean(contract?.subjectiveAcceptance)}`],
        fingerprint: summary,
      });
    }

    return null;
  }
}
