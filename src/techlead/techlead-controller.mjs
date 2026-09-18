/**
 * P3 TechLead — Shadow Mode controller.
 *
 * Event-driven sidecar: deterministic monitoring first, at most one startup
 * review per Work, and a bounded reviewer call only for meaningful incidents.
 * Zero-token standby: no timers, no polling, no model call when nothing
 * interesting happens.
 *
 * SHADOW SAFETY: TechLead output is advisory only. This module has no import of
 * any insert/pause/stop/tool/file API, and `automation` (the future action
 * interface) is never invoked in P3. Every automated-action attempt is recorded
 * and would fail the Shadow invariant.
 */
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../secrets.mjs';
import { deriveWorkContract } from './work-contract.mjs';
import {
  emptyFingerprint, applyEvent, materialHash, summarizeFingerprint,
} from './progress-fingerprint.mjs';
import { IncidentDetector } from './incident-detector.mjs';
import { IncidentDeduper, incidentSignature } from './incident-deduper.mjs';
import { buildIncidentPacket, DEFAULT_PACKET_MAX_CHARS } from './incident-packet.mjs';
import { REVIEW_ACTION } from './techlead-reviewer.mjs';
import { WORK_EVENT, toWorkEvent } from './work-event.mjs';

export const TECHLEAD_MODE = Object.freeze({ SHADOW: 'shadow', OFF: 'off' });

export const TECHLEAD_STATE = Object.freeze({
  DISABLED: 'DISABLED',
  SLEEPING: 'SLEEPING',
  REVIEWING: 'REVIEWING',
  DEGRADED: 'DEGRADED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
});

export const EVENT_VISIBILITY = Object.freeze({ FULL: 'FULL', PARTIAL: 'PARTIAL', DEGRADED: 'DEGRADED' });

const DEFAULT_POLICY = Object.freeze({
  maxWakes: 6,
  cooldownMs: 5 * 60 * 1000,
  packetMaxChars: DEFAULT_PACKET_MAX_CHARS,
  stagnationRepeats: 3,
  planThrashFlips: 3,
  repeatedTestFailures: 2,
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizePolicy(policy = {}) {
  return {
    maxWakes: clampInt(policy.maxWakes, DEFAULT_POLICY.maxWakes, 0, 1000),
    cooldownMs: clampInt(policy.cooldownMs, DEFAULT_POLICY.cooldownMs, 0, 24 * 60 * 60 * 1000),
    packetMaxChars: clampInt(policy.packetMaxChars, DEFAULT_POLICY.packetMaxChars, 800, 20000),
    stagnationRepeats: clampInt(policy.stagnationRepeats, DEFAULT_POLICY.stagnationRepeats, 2, 50),
    planThrashFlips: clampInt(policy.planThrashFlips, DEFAULT_POLICY.planThrashFlips, 2, 50),
    repeatedTestFailures: clampInt(policy.repeatedTestFailures, DEFAULT_POLICY.repeatedTestFailures, 2, 50),
  };
}

/**
 * Safe capability probe. It only inspects already-discovered executor metadata;
 * it performs no destructive or external side effect.
 */
export function detectEventVisibility({ executor = null, structured = null } = {}) {
  if (structured === true) return { status: EVENT_VISIBILITY.FULL, detail: 'structured events available' };
  if (structured === false) return { status: EVENT_VISIBILITY.PARTIAL, detail: 'lifecycle-only events' };
  if (!executor) return { status: EVENT_VISIBILITY.DEGRADED, detail: 'no executor/event integration' };
  const capabilities = executor.capabilities ?? [];
  if (typeof executor.normalizeEvent === 'function' && capabilities.includes('stream-json')) {
    return { status: EVENT_VISIBILITY.FULL, detail: 'structured stream-json events' };
  }
  if (executor.available === false) return { status: EVENT_VISIBILITY.DEGRADED, detail: 'executor unavailable' };
  return { status: EVENT_VISIBILITY.PARTIAL, detail: 'lifecycle available, no structured tool events' };
}

function prettyModel(model) {
  const value = String(model ?? '').trim();
  if (!value) return 'unknown';
  return value
    .replace(/^grok-?/i, 'Grok ')
    .replace(/^deepseek-?/i, 'DeepSeek ')
    .replace(/^glm-?/i, 'GLM ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TechLeadController {
  constructor({
    enabled = true,
    mode = TECHLEAD_MODE.SHADOW,
    reviewer = null,
    store = null,
    policy = {},
    now = () => Date.now(),
    logger = console,
    onAdvisory = null,
    automation = null,
  } = {}) {
    this.mode = String(mode ?? '').toLowerCase() === TECHLEAD_MODE.OFF ? TECHLEAD_MODE.OFF : TECHLEAD_MODE.SHADOW;
    this.enabled = Boolean(enabled) && this.mode !== TECHLEAD_MODE.OFF;
    this.reviewer = reviewer;
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.onAdvisory = typeof onAdvisory === 'function' ? onAdvisory : null;
    // Future automatic-action interface. P3 SHADOW must never call it.
    this.automation = automation;
    this.policy = normalizePolicy(policy);
    this.detector = new IncidentDetector({ thresholds: this.policy, now });
    this.deduper = new IncidentDeduper({ cooldownMs: this.policy.cooldownMs, now });
    this.metrics = {
      startupReviewCalls: 0,
      incidentReviewCalls: 0,
      duplicateIncidentsSuppressed: 0,
      parseErrors: 0,
      wakeBudgetUsed: 0,
      latencies: [],
      modelCalls: 0,
      actualProvider: null,
      actualModel: null,
      eventVisibility: EVENT_VISIBILITY.DEGRADED,
      usage: null,
    };
    // Shadow invariant ledger: must remain empty for the whole session.
    this.automatedActions = [];
    this.state = this.enabled ? TECHLEAD_STATE.SLEEPING : TECHLEAD_STATE.DISABLED;
    this.eventVisibility = EVENT_VISIBILITY.DEGRADED;
    this.work = null;
    this.contract = null;
    this.fingerprint = emptyFingerprint();
    this.previousFingerprint = null;
    this.events = [];
    this.advisories = [];
    this.lastReview = null;
    this.restore();
  }

  get status() {
    return this.state;
  }

  get modelLabel() {
    return this.reviewer?.route?.model ?? this.reviewer?.logicalModel ?? null;
  }

  get providerLabel() {
    return this.reviewer?.route?.providerId ?? this.reviewer?.providerId ?? null;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Start (or continue) observing one explicit Work. Per-Work state resets when
   * the Work key changes or the previous Work completed, so stale state never
   * leaks into a new Work. Fires at most one startup review, never blocking.
   */
  async beginWork({
    key = null, channelId = null, runId = null, prompt = '', contract = null, spec = null,
    capability = null, executor = null,
  } = {}) {
    if (!this.enabled) return { started: false, reason: 'disabled' };
    try {
      // Two identities: the instance key resets per-Work state (budget/startup),
      // while the stable key (channel-based when possible) keeps incident dedupe
      // effective across a bridge restart.
      const instanceKey = key ?? `${channelId ?? 'unknown'}:${runId ?? randomUUID()}`;
      const stableKey = channelId ? `channel:${channelId}` : instanceKey;
      const changed = !this.work || this.work.instanceKey !== instanceKey || this.work.completed;
      if (changed) {
        this.work = {
          instanceKey,
          stableKey,
          key: instanceKey,
          channelId,
          runId,
          startedAt: this.now(),
          wakeCount: 0,
          startupReviewed: false,
          completed: false,
          lastIncident: null,
          lastAdvisory: null,
          suppressed: 0,
        };
        this.detector = new IncidentDetector({ thresholds: this.policy, now: this.now });
        this.fingerprint = emptyFingerprint();
        this.previousFingerprint = null;
        this.events = [];
        this.state = TECHLEAD_STATE.SLEEPING;
      } else {
        this.work.channelId = channelId ?? this.work.channelId;
        this.work.runId = runId ?? this.work.runId;
      }
      this.contract = contract ?? deriveWorkContract({ prompt, spec });
      if (capability) {
        this.eventVisibility = typeof capability === 'string' ? capability : capability.status;
        if (capability.detail) this.eventDetail = capability.detail;
      } else if (executor) {
        const probe = detectEventVisibility({ executor });
        this.eventVisibility = probe.status;
        this.eventDetail = probe.detail;
      }
      this.metrics.eventVisibility = this.eventVisibility;
      this.persist();
      await this.#startupReview();
      return { started: true, key: instanceKey, stableKey, contract: this.contract, eventVisibility: this.eventVisibility };
    } catch (error) {
      this.logger?.warn?.(`[techlead] beginWork failed open: ${redactSecrets(error?.message || error)}`);
      return { started: false, reason: 'error' };
    }
  }

  /**
   * Observe one runner/lifecycle signal. Returns the detected incident (or null).
   * The review runs inline so deterministic tests can await it; the UI calls it
   * fire-and-forget and a reviewer failure can never break Work.
   */
  async observe({
    event = null, channelId = null, runId = null, proposedNextAction = null,
    evidence = null, elapsedMs = null, testSummary = null, diffSummary = null,
  } = {}) {
    if (!this.enabled || !this.work) return null;
    let normalized;
    try { normalized = toWorkEvent(event, { at: this.now() }); }
    catch { return null; }
    if (!normalized) return null;
    if (channelId) this.work.channelId = channelId;
    if (runId) this.work.runId = runId;

    this.#pushEvent(normalized);
    this.previousFingerprint = this.fingerprint;
    this.fingerprint = applyEvent(this.fingerprint, normalized, { evidence });

    let incident = null;
    try {
      incident = this.detector.observe({
        event: normalized,
        fingerprint: this.fingerprint,
        previousFingerprint: this.previousFingerprint,
        contract: this.contract,
        proposedNextAction,
      });
    } catch (error) {
      this.logger?.warn?.(`[techlead] detection failed: ${redactSecrets(error?.message || error)}`);
    }

    if (incident) {
      incident.window = {
        elapsedMs: elapsedMs ?? (this.now() - (this.work.startedAt ?? this.now())),
        proposedNextAction: proposedNextAction ?? incident.proposedAction ?? null,
        testSummary,
        diffSummary,
        channelId: this.work.channelId,
      };
      await this.#handleIncident(incident);
    }

    if (normalized.type === WORK_EVENT.WORK_COMPLETED) this.completeWork({ status: 'DONE' });
    else if (normalized.type === WORK_EVENT.WORK_FAILED) this.completeWork({ status: 'FAILED' });
    else if (normalized.type === WORK_EVENT.WORK_STOPPED) this.completeWork({ status: 'STOPPED' });
    return incident;
  }

  completeWork({ status = 'DONE' } = {}) {
    if (!this.work) return;
    this.work.completed = true;
    this.work.completedAt = this.now();
    this.work.completedStatus = status;
    if (this.state !== TECHLEAD_STATE.BUDGET_EXHAUSTED) {
      this.state = this.reviewer?.status === 'DEGRADED' ? TECHLEAD_STATE.DEGRADED : TECHLEAD_STATE.SLEEPING;
    }
    this.persist();
  }

  setAdvisoryHandler(handler) {
    this.onAdvisory = typeof handler === 'function' ? handler : null;
  }

  // ------------------------------------------------------------------- internals

  #pushEvent(event) {
    this.events.push(event);
    if (this.events.length > 40) this.events = this.events.slice(this.events.length - 40);
  }

  budgetRemaining() {
    return Math.max(0, this.policy.maxWakes - (this.work?.wakeCount ?? 0));
  }

  async #startupReview() {
    if (!this.enabled || !this.work) return null;
    if (this.work.startupReviewed) return null;
    // At most one startup review call per Work, even if beginWork is re-entered.
    this.work.startupReviewed = true;
    if (this.policy.maxWakes <= 0) {
      this.state = TECHLEAD_STATE.BUDGET_EXHAUSTED;
      this.persist();
      return null;
    }
    if (this.work.wakeCount >= this.policy.maxWakes) {
      this.state = TECHLEAD_STATE.BUDGET_EXHAUSTED;
      this.persist();
      return null;
    }
    return this.#runReview({ kind: 'startup', incident: null });
  }

  async #handleIncident(incident) {
    if (!this.work) return null;
    const signature = incidentSignature({
      workKey: this.work.stableKey ?? this.work.key,
      incidentClass: incident.class,
      action: incident.action,
      errorSignature: incident.errorSignature,
      fingerprintHash: incident.fingerprint?.materialHash ?? materialHash(this.fingerprint),
    });
    const gate = this.deduper.shouldWake(signature, { at: this.now() });
    if (!gate.wake) {
      this.metrics.duplicateIncidentsSuppressed += 1;
      this.work.suppressed = (this.work.suppressed ?? 0) + 1;
      this.persist();
      return { suppressed: true, signature, remainingMs: gate.remainingMs };
    }
    if (this.work.wakeCount >= this.policy.maxWakes || this.policy.maxWakes <= 0) {
      this.state = TECHLEAD_STATE.BUDGET_EXHAUSTED;
      this.persist();
      return { budgetExhausted: true, signature };
    }
    // Record BEFORE the call so a duplicate landing during review is suppressed.
    this.deduper.record(signature, { at: this.now() });
    this.work.lastIncident = { class: incident.class, signature, at: this.now() };
    const result = await this.#runReview({ kind: 'incident', incident });
    return { signature, reviewed: true, result };
  }

  async #runReview({ kind, incident }) {
    if (!this.work) return null;
    this.work.wakeCount += 1;
    this.metrics.wakeBudgetUsed += 1;
    if (kind === 'startup') this.metrics.startupReviewCalls += 1;
    else this.metrics.incidentReviewCalls += 1;
    this.state = TECHLEAD_STATE.REVIEWING;

    let result;
    try {
      const packet = kind === 'startup' ? this.#buildStartupPacket() : this.#buildIncidentPacket(incident);
      result = this.reviewer
        ? await this.reviewer.review({ packet, kind })
        : { ok: false, degraded: true, action: REVIEW_ACTION.CONTINUE, reason: 'no reviewer configured', latencyMs: 0 };
    } catch (error) {
      result = {
        ok: false,
        degraded: true,
        action: REVIEW_ACTION.CONTINUE,
        reason: redactSecrets(error?.message || error).slice(0, 200),
        latencyMs: 0,
      };
    }

    if (result?.latencyMs) this.metrics.latencies.push(result.latencyMs);
    if (result?.parseFailed) this.metrics.parseErrors += 1;
    if (result?.providerId) this.metrics.actualProvider = result.providerId;
    if (result?.model) this.metrics.actualModel = result.model;
    if (result?.usage) this.metrics.usage = result.usage;
    if (this.reviewer?.calls != null) this.metrics.modelCalls = this.reviewer.calls;

    const advisory = this.#recordAdvisory({ result, incident, kind });
    if (this.work && result?.ok && kind === 'incident') this.work.lastAdvisory = advisory;
    if (this.work) {
      this.state = this.work.wakeCount >= this.policy.maxWakes
        ? TECHLEAD_STATE.BUDGET_EXHAUSTED
        : (result?.degraded ? TECHLEAD_STATE.DEGRADED : TECHLEAD_STATE.SLEEPING);
    } else {
      this.state = result?.degraded ? TECHLEAD_STATE.DEGRADED : TECHLEAD_STATE.SLEEPING;
    }
    this.persist();
    this.logger?.log?.(`[techlead] review kind=${kind} action=${result?.action ?? 'n/a'} ok=${Boolean(result?.ok)} provider=${result?.providerId ?? '-'} model=${result?.model ?? '-'} latencyMs=${result?.latencyMs ?? 0} wakes=${this.work?.wakeCount ?? 0}/${this.policy.maxWakes}`);
    return result;
  }

  /**
   * SHADOW-mode recording. The reviewer may return SUGGEST_INJECT /
   * SUGGEST_PAUSE_REPLAN / ASK_OWNER; none of them can cause a Worker side
   * effect here. `automation` is deliberately never called.
   */
  #recordAdvisory({ result, incident, kind }) {
    if (!result || !result.ok) return null;
    const advisory = {
      id: randomUUID(),
      at: this.now(),
      kind,
      channelId: this.work?.channelId ?? null,
      runId: this.work?.runId ?? null,
      action: result.action,
      reason: redactSecrets(result.reason ?? '').slice(0, 240),
      instruction: redactSecrets(result.instruction ?? '').slice(0, 360),
      confidence: result.confidence ?? null,
      incidentClass: incident?.class ?? null,
      providerId: result.providerId ?? null,
      model: result.model ?? null,
      shadow: true,
      automated: false,
    };
    this.advisories.push(advisory);
    if (this.advisories.length > 50) this.advisories = this.advisories.slice(this.advisories.length - 50);
    // Continue is record-only; a material suggestion is shown once via the
    // existing Work status flow. The startup watch profile is never shown as a
    // corrective advisory.
    if (kind === 'incident' && result.action !== REVIEW_ACTION.CONTINUE && this.onAdvisory) {
      try {
        Promise.resolve(this.onAdvisory(advisory)).catch(() => {});
      } catch { /* advisory delivery must never break Work */ }
    }
    return advisory;
  }

  #buildStartupPacket() {
    const contract = this.contract ?? deriveWorkContract({});
    const text = [
      'STARTUP REVIEW',
      `workKey: ${this.work?.key ?? 'unknown'}`,
      `WORK CONTRACT: ${JSON.stringify({
        objective: contract.objective,
        constraints: contract.constraints,
        acceptance: contract.acceptance,
        do_not: contract.do_not,
        risk: contract.risk,
      })}`,
      `RUNTIME: eventVisibility=${this.eventVisibility} risk=${contract.risk}`,
      'Return a compact watch profile / missing-risk note as the JSON schema. Do not re-plan the task.',
    ].join('\n');
    const bounded = text.length > this.policy.packetMaxChars ? `${text.slice(0, this.policy.packetMaxChars - 20)}\n…[truncated]` : text;
    return { text: redactSecrets(bounded), chars: bounded.length, truncated: bounded.length < text.length, maxChars: this.policy.packetMaxChars };
  }

  #buildIncidentPacket(incident) {
    const window = incident?.window ?? {};
    return buildIncidentPacket({
      workKey: this.work?.key ?? 'unknown',
      channelId: this.work?.channelId ?? null,
      contract: this.contract,
      incident,
      fingerprint: this.fingerprint,
      previousFingerprint: this.previousFingerprint,
      events: this.events,
      elapsedMs: window.elapsedMs ?? null,
      proposedNextAction: window.proposedNextAction ?? null,
      testSummary: window.testSummary ?? this.fingerprint.testState ?? null,
      diffSummary: window.diffSummary ?? null,
      maxChars: this.policy.packetMaxChars,
    });
  }

  // ---------------------------------------------------------------- status / state

  statusText() {
    if (!this.enabled) return 'TechLead: DISABLED';
    const mode = this.mode.toUpperCase();
    const wakes = `${this.work?.wakeCount ?? 0}/${this.policy.maxWakes}`;
    if (this.state === TECHLEAD_STATE.BUDGET_EXHAUSTED) return `TechLead: BUDGET_EXHAUSTED wakes=${wakes}`;
    if (this.state === TECHLEAD_STATE.REVIEWING) {
      const incident = this.work?.lastIncident?.class ?? 'startup';
      return `TechLead: REVIEWING incident=${incident}`;
    }
    if (this.state === TECHLEAD_STATE.DEGRADED || this.reviewer?.status === 'DEGRADED') {
      return 'TechLead: DEGRADED provider unavailable';
    }
    return `TechLead: ${mode} / ${prettyModel(this.modelLabel)} / ${this.state}`;
  }

  statusSnapshot() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      state: this.state,
      eventVisibility: this.eventVisibility,
      workKey: this.work?.key ?? null,
      wakes: this.work?.wakeCount ?? 0,
      maxWakes: this.policy.maxWakes,
      provider: this.metrics.actualProvider ?? this.providerLabel,
      model: this.metrics.actualModel ?? this.modelLabel,
      reviewerStatus: this.reviewer?.status ?? 'UNKNOWN',
      lastIncident: this.work?.lastIncident ?? null,
      lastAdvisory: this.advisories.at(-1) ?? null,
      metrics: this.metricsSnapshot(),
    };
  }

  metricsSnapshot() {
    const latencies = this.metrics.latencies ?? [];
    const avg = latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null;
    return {
      startup_review_calls: this.metrics.startupReviewCalls,
      incident_review_calls: this.metrics.incidentReviewCalls,
      duplicate_incidents_suppressed: this.metrics.duplicateIncidentsSuppressed,
      wake_budget_used: this.metrics.wakeBudgetUsed,
      techlead_latency_ms: avg,
      actual_provider: this.metrics.actualProvider ?? this.providerLabel,
      actual_model: this.metrics.actualModel ?? this.modelLabel,
      event_visibility: this.eventVisibility,
      provider_usage: this.metrics.usage ?? null,
      automated_actions: this.automatedActions.length,
    };
  }

  snapshot() {
    return {
      version: 1,
      mode: this.mode,
      eventVisibility: this.eventVisibility,
      dedupe: this.deduper.snapshot(),
      work: this.work
        ? {
          key: this.work.instanceKey ?? this.work.key,
          stableKey: this.work.stableKey ?? null,
          channelId: this.work.channelId,
          wakeCount: this.work.wakeCount,
          startupReviewed: this.work.startupReviewed,
          completed: this.work.completed,
          lastIncident: this.work.lastIncident,
        }
        : null,
      lastAdvisory: this.advisories.at(-1) ?? null,
      metrics: this.metricsSnapshot(),
    };
  }

  persist() {
    try { this.store?.save?.(this.snapshot()); }
    catch (error) { this.logger?.warn?.(`[techlead] persist failed: ${redactSecrets(error?.message || error)}`); }
  }

  restore() {
    let data = null;
    try { data = this.store?.load?.(); } catch { data = null; }
    if (!data || typeof data !== 'object') return;
    try {
      if (Array.isArray(data.dedupe)) this.deduper.restore(data.dedupe, { at: this.now() });
      if (data.eventVisibility) this.eventVisibility = data.eventVisibility;
      if (data.work && typeof data.work === 'object') {
        this.work = {
          key: data.work.key ?? null,
          instanceKey: data.work.key ?? null,
          stableKey: data.work.stableKey ?? null,
          channelId: data.work.channelId ?? null,
          runId: null,
          startedAt: this.now(),
          wakeCount: Number(data.work.wakeCount) || 0,
          startupReviewed: Boolean(data.work.startupReviewed),
          completed: Boolean(data.work.completed),
          lastIncident: data.work.lastIncident ?? null,
          lastAdvisory: null,
          suppressed: 0,
        };
      }
      if (data.lastAdvisory) this.advisories.push(data.lastAdvisory);
      if (data.metrics) {
        this.metrics.startupReviewCalls = Number(data.metrics.startup_review_calls) || 0;
        this.metrics.incidentReviewCalls = Number(data.metrics.incident_review_calls) || 0;
        this.metrics.duplicateIncidentsSuppressed = Number(data.metrics.duplicate_incidents_suppressed) || 0;
        this.metrics.wakeBudgetUsed = Number(data.metrics.wake_budget_used) || 0;
        this.metrics.actualProvider = data.metrics.actual_provider ?? null;
        this.metrics.actualModel = data.metrics.actual_model ?? null;
      }
    } catch { /* corrupt TechLead state must never break startup */ }
  }
}
