/**
 * P3 TechLead — provider/model reviewer adapter.
 *
 * Reuses the existing provider + credential + ChatRuntime infrastructure. The
 * route is resolved through discovery where possible (default logical target
 * "Grok 4.6"), the actual provider/model used is reported, and a missing/
 * unavailable route is DEGRADED instead of silently spending on a metered
 * fallback.
 */
import { redactSecrets } from '../secrets.mjs';
import { PROTOCOL, TRANSPORT, openCodeGoTransport } from '../provider-manager.mjs';

export const REVIEW_ACTION = Object.freeze({
  CONTINUE: 'CONTINUE',
  SUGGEST_INJECT: 'SUGGEST_INJECT',
  SUGGEST_PAUSE_REPLAN: 'SUGGEST_PAUSE_REPLAN',
  ASK_OWNER: 'ASK_OWNER',
});

export const REVIEW_ACTIONS = Object.values(REVIEW_ACTION);

export const REVIEW_SYSTEM = [
  'You are Jarvis TechLead in SHADOW mode. You only advise; you never act.',
  'Judge whether the Worker is stagnating or diverging from the Work Contract.',
  'Return ONLY a compact JSON object, no prose and no chain-of-thought:',
  '{"action":"CONTINUE|SUGGEST_INJECT|SUGGEST_PAUSE_REPLAN|ASK_OWNER","reason":"<=200 chars","instruction":"<=300 chars or empty","confidence":0.0}',
  'Use CONTINUE when the evidence is weak or the Worker is making progress.',
  'Prefer SUGGEST_PAUSE_REPLAN for repeated failure with no new evidence.',
  'Use ASK_OWNER when an owner decision is required.',
].join('\n');

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) : value;
}

/** Strict, bounded response parser. Unknown/invalid output falls back to CONTINUE. */
export function parseReviewResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, action: REVIEW_ACTION.CONTINUE, reason: 'empty review response', instruction: '', confidence: null };
  let candidate = raw;
  if (!candidate.startsWith('{')) {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (match) candidate = match[0];
  }
  let data = null;
  try { data = JSON.parse(candidate); } catch { data = null; }
  if (!data || typeof data !== 'object') {
    return { ok: false, action: REVIEW_ACTION.CONTINUE, reason: 'unparseable review response', instruction: '', confidence: null };
  }
  const action = String(data.action ?? '').trim().toUpperCase();
  if (!REVIEW_ACTIONS.includes(action)) {
    return { ok: false, action: REVIEW_ACTION.CONTINUE, reason: 'unknown review action', instruction: '', confidence: null };
  }
  const confidence = Number.isFinite(Number(data.confidence))
    ? Math.max(0, Math.min(1, Number(data.confidence)))
    : null;
  return {
    ok: true,
    action,
    reason: clip(data.reason, 240),
    instruction: clip(data.instruction, 360),
    confidence,
  };
}

export function buildReviewPrompt({ packet }) {
  return {
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: String(packet?.text ?? packet ?? '') }],
  };
}

function matchesModel(models, wanted) {
  const target = String(wanted ?? '').trim().toLowerCase();
  if (!target) return null;
  const ids = (models ?? []).map((model) => (typeof model === 'string' ? model : model.id)).filter(Boolean);
  return ids.find((id) => id.toLowerCase() === target)
    ?? ids.find((id) => id.toLowerCase().startsWith(target))
    ?? ids.find((id) => id.toLowerCase().includes(target.replace(/[.\s]/g, '-')))
    ?? ids.find((id) => target.includes(id.toLowerCase()))
    ?? null;
}

/**
 * Resolve the TechLead reviewer route. `providerId`/`model` may come from config;
 * otherwise the OpenCode Go model library resolves the logical "grok-4.6"
 * target so no assumed remote model id is hardcoded.
 */
export function resolveTechLeadRoute({ providerManager = null, providerId = null, model = 'grok-4.6' } = {}) {
  if (!providerManager?.get) return null;
  const provider = providerManager.get(providerId || 'opencode-go');
  if (!provider) return null;
  if (providerManager.hasCredential && !providerManager.hasCredential(provider)) return null;
  const models = provider.models ?? [];
  const resolvedModel = matchesModel(models, model) || (models.length === 0 && providerId ? model : null);
  if (!resolvedModel) return null;
  const transport = provider.protocol === PROTOCOL.OPENCODE_GO
    ? (models.find((item) => item.id === resolvedModel)?.transport || openCodeGoTransport(resolvedModel))
    : (provider.protocol === PROTOCOL.ANTHROPIC ? TRANSPORT.ANTHROPIC_MESSAGES : TRANSPORT.OPENAI_CHAT);
  return {
    providerId: provider.id,
    providerName: provider.displayName ?? provider.id,
    model: resolvedModel,
    transport,
    billingType: provider.billingType ?? null,
    source: providerId ? 'configured' : 'discovered',
  };
}

export class TechLeadReviewer {
  constructor({
    chatRuntime = null,
    providerManager = null,
    providerId = null,
    model = 'grok-4.6',
    enabled = true,
    maxPacketChars = 6000,
    logger = console,
  } = {}) {
    this.chatRuntime = chatRuntime;
    this.providerManager = providerManager;
    this.providerId = providerId;
    this.logicalModel = model;
    this.enabled = enabled;
    this.maxPacketChars = maxPacketChars;
    this.logger = logger;
    this.route = enabled ? resolveTechLeadRoute({ providerManager, providerId, model }) : null;
    this.calls = 0;
    this.reasons = [];
  }

  get status() {
    if (!this.enabled) return 'DISABLED';
    if (!this.chatRuntime) return 'DEGRADED';
    return this.route ? 'READY' : 'DEGRADED';
  }

  get reason() {
    if (!this.enabled) return 'disabled';
    if (!this.chatRuntime) return 'no chat runtime';
    if (!this.route) return `no available ${this.providerId || 'opencode-go'} model matching ${this.logicalModel}`;
    return null;
  }

  describe() {
    return {
      status: this.status,
      providerId: this.route?.providerId ?? this.providerId ?? null,
      model: this.route?.model ?? this.logicalModel,
      transport: this.route?.transport ?? null,
      billingType: this.route?.billingType ?? null,
      routeSource: this.route?.source ?? null,
      reason: this.reason,
    };
  }

  /**
   * Re-resolve the route. Provider model lists can be discovered lazily after
   * startup, so a reviewer that started DEGRADED can become READY without a
   * restart. Discovery only; it never triggers a model call.
   */
  refreshRoute() {
    if (!this.enabled) return null;
    this.route = resolveTechLeadRoute({ providerManager: this.providerManager, providerId: this.providerId, model: this.logicalModel });
    return this.route;
  }

  /**
   * One bounded review call. A pinned provider/model means no silent
   * cross-provider fallback: a failure is a DEGRADED result, not a paid detour.
   */
  async review({ packet } = {}) {
    const startedAt = Date.now();
    if (!this.route) this.refreshRoute();
    const describe = this.describe();
    if (this.status !== 'READY') {
      return { ok: false, degraded: true, action: REVIEW_ACTION.CONTINUE, reason: this.reason, latencyMs: 0, ...describe };
    }
    const prompt = buildReviewPrompt({ packet });
    if (prompt.messages[0].content.length > this.maxPacketChars + 2000) {
      prompt.messages[0].content = prompt.messages[0].content.slice(0, this.maxPacketChars + 2000);
    }
    this.calls += 1;
    try {
      const result = await this.chatRuntime.send({
        messages: prompt.messages,
        system: prompt.system,
        providerId: this.route.providerId,
        model: this.route.model,
      });
      const latencyMs = Date.now() - startedAt;
      const parsed = parseReviewResponse(result?.text);
      const usage = result?.usage ?? result?.raw?.usage ?? null;
      const report = {
        ...describe,
        providerId: result?.providerId ?? this.route.providerId,
        providerName: result?.providerName ?? describe.providerName,
        model: result?.model ?? this.route.model,
        latencyMs,
        usage: usage ? redactSecrets(usage) : null,
      };
      if (!parsed.ok) {
        this.reasons.push(parsed.reason);
        return { ...report, ok: false, parseFailed: true, action: parsed.action, reason: parsed.reason, instruction: parsed.instruction, confidence: parsed.confidence };
      }
      return { ...report, ok: true, action: parsed.action, reason: parsed.reason, instruction: parsed.instruction, confidence: parsed.confidence };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const detail = redactSecrets(error?.message || error).slice(0, 200);
      this.reasons.push(detail);
      return { ...describe, ok: false, degraded: true, action: REVIEW_ACTION.CONTINUE, reason: detail, errorCode: error?.code ?? 'UNKNOWN', latencyMs };
    }
  }
}
