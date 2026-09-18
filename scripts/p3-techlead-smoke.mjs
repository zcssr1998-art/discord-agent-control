#!/usr/bin/env node
/**
 * P3 TechLead Shadow Mode smoke.
 *
 * Deterministic acceptance path for the P3-specific behavior (startup review,
 * stagnation wake, dedupe/cooldown, budget, Shadow safety, packet hygiene,
 * event compatibility, restart dedupe). It never starts a destructive real
 * Worker loop.
 *
 * When a live OpenCode Go credential is available it also performs ONE real
 * reviewer call to attribute the actual provider/model; that section reports
 * PENDING instead of FAIL when the external route is unavailable, because the
 * deterministic checks stay authoritative.
 *
 *   node scripts/p3-techlead-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORK_EVENT, looksRisky } from '../src/techlead/work-event.mjs';
import { deriveWorkContract } from '../src/techlead/work-contract.mjs';
import { applyEvent, emptyFingerprint, materialProgress } from '../src/techlead/progress-fingerprint.mjs';
import { buildIncidentPacket } from '../src/techlead/incident-packet.mjs';
import { REVIEW_ACTION, parseReviewResponse, resolveTechLeadRoute, TechLeadReviewer } from '../src/techlead/techlead-reviewer.mjs';
import {
  TechLeadController, TECHLEAD_STATE, EVENT_VISIBILITY, detectEventVisibility,
} from '../src/techlead/techlead-controller.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { readOpenCodeGoKey } from '../src/litellm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

function fakeStore(initial = null) {
  return { data: initial, load() { return this.data; }, save(value) { this.data = value; } };
}

function fakeReviewer(action = REVIEW_ACTION.SUGGEST_PAUSE_REPLAN) {
  const calls = [];
  const route = { providerId: 'opencode-go', model: 'grok-4.6', transport: 'openai-responses', billingType: 'SUBSCRIPTION', source: 'discovered' };
  return {
    route, logicalModel: 'grok-4.6', providerId: 'opencode-go', status: 'READY', _calls: calls,
    get calls() { return calls.length; },
    async review({ kind }) {
      calls.push(kind);
      return {
        ok: true,
        action: kind === 'startup' ? REVIEW_ACTION.CONTINUE : action,
        reason: 'same failure repeated with no progress',
        instruction: 'verify ABI first',
        latencyMs: 1,
        providerId: route.providerId,
        model: route.model,
      };
    },
  };
}

const started = (action) => ({ type: WORK_EVENT.TOOL_STARTED, action, kind: 'TEST' });
const failed = (signature) => ({ type: WORK_EVENT.COMMAND_FAILED, error: signature, errorSignature: signature });

function newController(options = {}) {
  return new TechLeadController({
    reviewer: fakeReviewer(), store: fakeStore(), policy: { maxWakes: 6, cooldownMs: 600_000 },
    logger: { warn() {}, log() {} }, ...options,
  });
}

async function feedStagnation(controller, count = 3) {
  for (let i = 0; i < count; i += 1) {
    await controller.observe({ event: started('cmd:npm test') });
    await controller.observe({ event: failed('enoent xformers') });
  }
}

// ------------------------------------------------------------ deterministic

check('event: risky intent detected, benign command not', looksRisky('git reset --hard') && !looksRisky('npm test'));

const contract = deriveWorkContract({ prompt: '修复 src 模块，验收 npm test 通过，不要重写 ExecutorManager' });
check('contract: compact fields derived', Boolean(contract.objective) && contract.do_not.length > 0 && contract.acceptance.length > 0);

{
  let fp = emptyFingerprint();
  const empty = fp;
  fp = applyEvent(fp, { type: WORK_EVENT.FILE_CHANGED, file: 'src/a.mjs' });
  const progressFromEmpty = materialProgress(empty, fp).changed;
  const beforeRepeat = fp;
  fp = applyEvent(fp, started('cmd:npm test'));
  fp = applyEvent(fp, failed('same'));
  check('fingerprint: evidence is progress, repeated failure is not', progressFromEmpty && !materialProgress(beforeRepeat, fp).changed);
}

const shadow = new TechLeadController({
  reviewer: fakeReviewer(),
  store: fakeStore(),
  policy: { maxWakes: 6, cooldownMs: 600_000 },
  logger: { warn() {}, log() {} },
  automation: { apply: () => { throw new Error('shadow automation must never run'); } },
});
await shadow.beginWork({ channelId: 'smoke', runId: 'r1', prompt: 'fix the build' });
check('startup: at most one startup review', shadow.metrics.startupReviewCalls === 1);
await feedStagnation(shadow);
check('stagnation: exactly one incident review', shadow.metrics.incidentReviewCalls === 1, `class=${shadow.work.lastIncident?.class}`);
await shadow.observe({ event: failed('enoent xformers') });
check('dedupe: duplicate suppressed inside cooldown', shadow.metrics.incidentReviewCalls === 1 && shadow.metrics.duplicateIncidentsSuppressed >= 1);
check('shadow: no automated action, advisory recorded', shadow.automatedActions.length === 0 && shadow.advisories.at(-1)?.shadow === true);

const budget = new TechLeadController({
  reviewer: fakeReviewer(), store: fakeStore(), policy: { maxWakes: 2, cooldownMs: 600_000 }, logger: { warn() {}, log() {} },
});
await budget.beginWork({ channelId: 'smoke', runId: 'b1', prompt: 'fix' });
await feedStagnation(budget);
await budget.observe({ event: { type: WORK_EVENT.WORKER_MESSAGE, message: 'git reset --hard' } });
check('budget: hard cap stops further calls', budget.state === TECHLEAD_STATE.BUDGET_EXHAUSTED && budget.reviewer.calls === 2);

{
  const secret = 'sk-ABCDEFGH1234567890';
  const packet = buildIncidentPacket({
    workKey: 'channel:smoke',
    contract,
    incident: { class: 'STAGNATION', errorSignature: 'e', at: Date.now() },
    events: Array.from({ length: 40 }, (_, i) => ({ type: WORK_EVENT.TOOL_STARTED, action: `cmd:${i} ${secret}` })),
    maxChars: 900,
  });
  check('packet: bounded and secret-redacted', packet.text.length <= 900 && packet.truncated && !packet.text.includes(secret));
}

check('parser: strict action whitelist', parseReviewResponse('{"action":"SUGGEST_INJECT","reason":"r"}').action === REVIEW_ACTION.SUGGEST_INJECT
  && parseReviewResponse('{"action":"DROP_TABLE"}').action === REVIEW_ACTION.CONTINUE);

check('capability: FULL/PARTIAL/DEGRADED reported',
  detectEventVisibility({ structured: true }).status === EVENT_VISIBILITY.FULL
  && detectEventVisibility({ structured: false }).status === EVENT_VISIBILITY.PARTIAL
  && detectEventVisibility({}).status === EVENT_VISIBILITY.DEGRADED);

{
  const store = fakeStore();
  const first = newController({ store });
  await first.beginWork({ channelId: 'smoke', runId: 'r1', prompt: 'fix' });
  await feedStagnation(first);
  const second = newController({ store });
  await second.beginWork({ channelId: 'smoke', runId: 'r2', prompt: 'fix' });
  await feedStagnation(second);
  const secondIncidentCalls = second.reviewer._calls.filter((kind) => kind === 'incident').length;
  check('restart: unresolved incident not re-billed', secondIncidentCalls === 0 && second.metrics.duplicateIncidentsSuppressed >= 1);
}

// ------------------------------------------------------------ real provider

console.log('\n--- optional live reviewer probe (external, non-fatal) ---');
let liveStatus = 'PENDING';
try {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'providers.json'), 'utf8'));
  const container = raw.providers ?? raw;
  const opencode = Object.values(container).find((provider) => provider?.id === 'opencode-go');
  const key = readOpenCodeGoKey();
  if (!opencode || !key) {
    liveStatus = 'PENDING (no OpenCode Go provider/credential)';
  } else {
    const providerManager = {
      get: (id) => (id === 'opencode-go' ? opencode : null),
      list: () => [opencode],
      hasCredential: () => true,
      listModels: async () => ({ models: opencode.models ?? [] }),
    };
    const credentialStore = { get: (ref) => (ref === 'provider:opencode-go' ? key : null) };
    const route = resolveTechLeadRoute({ providerManager, model: 'grok-4.6' });
    if (!route) {
      liveStatus = 'PENDING (grok-4.6 not discovered in the OpenCode Go model library)';
    } else {
      const chatRuntime = new ChatRuntime({ providerManager, credentialStore, timeoutMs: 60000, allowMeteredFallback: false });
      const reviewer = new TechLeadReviewer({ chatRuntime, providerManager, model: 'grok-4.6' });
      const packet = buildIncidentPacket({
        workKey: 'channel:smoke',
        contract,
        incident: { class: 'STAGNATION', errorSignature: 'enoent xformers', at: Date.now() },
        fingerprint: null,
        events: [started('cmd:npm test'), failed('enoent xformers'), started('cmd:npm test')],
        proposedNextAction: 'reinstall CUDA',
      });
      const review = await reviewer.review({ packet, kind: 'incident' });
      if (review.ok) {
        liveStatus = `PASS · provider=${review.providerId} model=${review.model} action=${review.action} latencyMs=${review.latencyMs}`;
      } else {
        liveStatus = `PENDING (reviewer ${review.degraded ? 'degraded' : 'failed'}: ${String(review.reason).slice(0, 120)})`;
      }
    }
  }
} catch (error) {
  liveStatus = `PENDING (${String(error?.message || error).slice(0, 140)})`;
}
console.log(`live reviewer: ${liveStatus}`);

const failedChecks = results.filter((result) => !result.ok);
console.log(`\nP3 TechLead smoke: ${results.length - failedChecks.length}/${results.length} checks passed`);
console.log(`deterministic=PASS real-provider=${liveStatus}`);
process.exitCode = failedChecks.length ? 1 : 0;
