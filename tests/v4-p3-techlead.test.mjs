/**
 * P3 — AI TechLead Shadow Mode.
 *
 * Deterministic coverage for the acceptance criteria:
 *   B zero-token standby; C startup review; D stagnation + control case;
 *   E budget; F shadow safety; G packet hygiene; H event compatibility;
 *   I persistence/restart. Plus one in-process Discord integration test proving
 *   an advisory is displayed and the Worker is untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { WorkspaceScheduler } from '../src/workspace-scheduler.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

import { WORK_EVENT, toWorkEvent, normalizeErrorSignature, extractTestState, looksRisky } from '../src/techlead/work-event.mjs';
import { deriveWorkContract, toContractPayload } from '../src/techlead/work-contract.mjs';
import { applyEvent, emptyFingerprint, materialProgress, materialHash } from '../src/techlead/progress-fingerprint.mjs';
import { IncidentDetector, INCIDENT_CLASS } from '../src/techlead/incident-detector.mjs';
import { IncidentDeduper, incidentSignature } from '../src/techlead/incident-deduper.mjs';
import { buildIncidentPacket } from '../src/techlead/incident-packet.mjs';
import {
  REVIEW_ACTION, parseReviewResponse, resolveTechLeadRoute, TechLeadReviewer,
} from '../src/techlead/techlead-reviewer.mjs';
import {
  TechLeadController, TECHLEAD_STATE, EVENT_VISIBILITY, detectEventVisibility,
} from '../src/techlead/techlead-controller.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await tick(5);
  }
  return false;
}

function fakeStore(initial = null) {
  return { data: initial, load() { return this.data; }, save(value) { this.data = value; } };
}

function fakeReviewer({
  action = REVIEW_ACTION.CONTINUE, reason = 'looks fine', instruction = '', status = 'READY', fail = false,
} = {}) {
  const calls = [];
  const route = { providerId: 'opencode-go', providerName: 'OpenCode Go', model: 'grok-4.6', transport: TRANSPORT.OPENAI_RESPONSES, billingType: 'SUBSCRIPTION', source: 'discovered' };
  return {
    route,
    logicalModel: 'grok-4.6',
    providerId: 'opencode-go',
    status,
    _calls: calls,
    get calls() { return calls.length; },
    describe() { return { status, ...route }; },
    async review({ packet, kind }) {
      calls.push({ packet, kind });
      if (fail) return { ok: false, degraded: true, action: REVIEW_ACTION.CONTINUE, reason: 'provider exploded', latencyMs: 7, providerId: route.providerId, model: route.model };
      return { ok: true, action, reason, instruction, confidence: 0.7, latencyMs: 12, providerId: route.providerId, providerName: route.providerName, model: route.model };
    },
  };
}

function newController(options = {}) {
  return new TechLeadController({
    reviewer: fakeReviewer(),
    store: fakeStore(),
    policy: { maxWakes: 6, cooldownMs: 60_000 },
    logger: { warn() {}, log() {} },
    ...options,
  });
}

const started = (action, kind = 'TEST') => ({ type: WORK_EVENT.TOOL_STARTED, action, kind });
const failed = (signature) => ({ type: WORK_EVENT.COMMAND_FAILED, error: signature, errorSignature: signature });
const succeeded = (action) => ({ type: WORK_EVENT.COMMAND_SUCCEEDED, action });
const fileChanged = (file) => ({ type: WORK_EVENT.FILE_CHANGED, file });

async function feedFailures(controller, { count = 3, action = 'cmd:npm test', signature = 'enoent xformers', file = null } = {}) {
  for (let i = 0; i < count; i += 1) {
    await controller.observe({ event: started(action) });
    if (file && i === count - 1) await controller.observe({ event: fileChanged(file) });
    await controller.observe({ event: failed(signature) });
  }
}

// -------------------------------------------------------------- work contract

test('P3 contract: derives compact objective/constraints/acceptance/risk/scope', () => {
  const contract = deriveWorkContract({
    prompt: [
      '修复 P3 TechLead Shadow Mode。',
      '必须保留 P2 行为。',
      '不要重写 ExecutorManager。',
      '验收：npm test 通过；npm run check 通过。',
      '涉及文件：src/discord-ui.mjs tests/v4-p3-techlead.test.mjs',
    ].join('\n'),
  });
  assert.match(contract.objective, /TechLead/);
  assert.ok(contract.constraints.some((line) => /保留 P2/.test(line)));
  assert.ok(contract.do_not.some((line) => /不要重写/.test(line)));
  assert.ok(contract.acceptance.some((line) => /npm test/.test(line)));
  assert.equal(contract.risk, 'low');
  assert.ok(contract.watch.includes('src/discord-ui.mjs'));
  const payload = toContractPayload(contract);
  assert.equal(payload.scope, undefined, 'internal detection helpers are not sent to the reviewer');
});

test('P3 contract: destructive language raises risk and owner_required', () => {
  const contract = deriveWorkContract({ prompt: '删除数据库并重装 CUDA 驱动，使用 git reset --hard' });
  assert.equal(contract.risk, 'high');
  assert.ok(contract.owner_required.length > 0);
});

// ---------------------------------------------------------- work event utils

test('P3 events: error signatures normalize ids/numbers/paths and risky intents are detected', () => {
  const a = normalizeErrorSignature('Error: ENOENT C:\\proj\\xformers\\a.py line 42 at 0xdeadbeef1234');
  const b = normalizeErrorSignature('Error: ENOENT C:\\other\\xformers\\b.py line 99 at 0x1234abcd9999');
  assert.equal(a, b, 'same normalized error signature despite different path/number');
  assert.equal(extractTestState('12 passed, 0 failed'), 'pass');
  assert.equal(extractTestState('3 failing'), 'fail');
  assert.equal(looksRisky('git reset --hard origin/main'), true);
  assert.equal(looksRisky('npm test'), false);
});

// ----------------------------------------------------------- fingerprint

test('P3 fingerprint: a repeated failed action is not progress; new evidence is', () => {
  let fp = emptyFingerprint();
  const empty = fp;
  fp = applyEvent(fp, fileChanged('src/a.mjs'));
  assert.equal(materialProgress(empty, fp).changed, true, 'a file change is progress from empty');
  const beforeRepeat = fp;
  fp = applyEvent(fp, started('cmd:npm test'));
  fp = applyEvent(fp, failed('enoent xformers'));
  assert.equal(materialProgress(beforeRepeat, fp).changed, false, 'a repeated failing action is not progress');
  const beforeEvidence = fp;
  fp = applyEvent(fp, fileChanged('src/b.mjs'));
  assert.equal(materialProgress(beforeEvidence, fp).changed, true, 'new evidence is material progress');
});

// ----------------------------------------------------------- detector

test('P3 detector: STAGNATION requires repeats + same error + no progress', () => {
  const detector = new IncidentDetector();
  const contract = deriveWorkContract({ prompt: 'fix the build' });
  let fp = emptyFingerprint();
  let incident = null;
  for (let i = 0; i < 3; i += 1) {
    let prev = fp;
    fp = applyEvent(fp, started('cmd:npm test'));
    incident = detector.observe({ event: started('cmd:npm test'), fingerprint: fp, previousFingerprint: prev, contract }) ?? incident;
    prev = fp;
    fp = applyEvent(fp, failed('enoent xformers'));
    incident = detector.observe({ event: failed('enoent xformers'), fingerprint: fp, previousFingerprint: prev, contract }) ?? incident;
  }
  assert.equal(incident?.class, INCIDENT_CLASS.STAGNATION);
});

test('P3 detector control: repeated action with new evidence is not stagnation', () => {
  const detector = new IncidentDetector();
  const contract = deriveWorkContract({ prompt: 'fix the build' });
  const events = [
    started('cmd:npm test'), failed('enoent xformers'),
    started('cmd:npm test'), fileChanged('src/x.mjs'), failed('enoent xformers'),
    started('cmd:npm test'), failed('enoent xformers'),
  ];
  let fp = emptyFingerprint();
  const incidents = [];
  for (const event of events) {
    const prev = fp;
    fp = applyEvent(fp, event);
    const incident = detector.observe({ event, fingerprint: fp, previousFingerprint: prev, contract });
    if (incident) incidents.push(incident);
  }
  assert.equal(incidents.length, 0, 'new evidence must suppress a stagnation classification');
});

test('P3 detector: risky intent, scope drift, repeated test failure and plan thrash', () => {
  const detector = new IncidentDetector();
  const contract = deriveWorkContract({ prompt: '修复 src 模块' });
  contract.scope = ['src/'];
  let fp = emptyFingerprint();

  const risky = detector.observe({
    event: { type: WORK_EVENT.WORKER_MESSAGE, message: '我先重装 CUDA 驱动再继续' },
    fingerprint: fp, previousFingerprint: fp, contract,
  });
  assert.equal(risky?.class, INCIDENT_CLASS.RISKY_NEXT_ACTION);

  fp = applyEvent(fp, fileChanged('C:/unrelated/secrets.txt'));
  const drift = detector.observe({
    event: fileChanged('C:/unrelated/secrets.txt'), fingerprint: fp, previousFingerprint: emptyFingerprint(), contract,
  });
  assert.equal(drift?.class, INCIDENT_CLASS.SCOPE_DRIFT);

  let fp2 = emptyFingerprint();
  fp2 = applyEvent(fp2, failed('same test failure'));
  fp2 = applyEvent(fp2, failed('same test failure'));
  fp2 = applyEvent(fp2, { type: WORK_EVENT.TEST_RESULT, testState: 'fail' });
  const testIncident = detector.observe({
    event: { type: WORK_EVENT.TEST_RESULT, testState: 'fail' },
    fingerprint: fp2, previousFingerprint: emptyFingerprint(), contract,
  });
  assert.equal(testIncident?.class, INCIDENT_CLASS.REPEATED_TEST_FAILURE);

  let fp3 = emptyFingerprint();
  let planIncident = null;
  for (const plan of ['plan A', 'plan B', 'plan C']) {
    const prev = fp3;
    fp3 = applyEvent(fp3, { type: WORK_EVENT.WORKER_PLAN_CHANGED, plan });
    planIncident = detector.observe({
      event: { type: WORK_EVENT.WORKER_PLAN_CHANGED, plan }, fingerprint: fp3, previousFingerprint: prev, contract,
    }) ?? planIncident;
  }
  assert.equal(planIncident?.class, INCIDENT_CLASS.PLAN_THRASH);
});

test('P3 detector: COMPLETION_REVIEW_NEEDED only for subjective/high-risk acceptance', () => {
  const detector = new IncidentDetector();
  const subjective = deriveWorkContract({ prompt: '改进整体产品体验和视觉设计，验收看主观感觉' });
  assert.equal(subjective.subjectiveAcceptance, true);
  const incident = detector.observe({
    event: { type: WORK_EVENT.WORK_COMPLETED }, fingerprint: emptyFingerprint(), previousFingerprint: emptyFingerprint(), contract: subjective,
  });
  assert.equal(incident?.class, INCIDENT_CLASS.COMPLETION_REVIEW_NEEDED);

  const deterministic = deriveWorkContract({ prompt: '修复构建，验收 npm test 通过' });
  assert.equal(deterministic.subjectiveAcceptance, false);
  const none = detector.observe({
    event: { type: WORK_EVENT.WORK_COMPLETED }, fingerprint: emptyFingerprint(), previousFingerprint: emptyFingerprint(), contract: deterministic,
  });
  assert.equal(none, null, 'a deterministic PASS must never trigger a TechLead call');
});

// ----------------------------------------------------------- dedupe

test('P3 dedupe: duplicate incident inside cooldown is suppressed; new state wakes', () => {
  let now = 1_000_000;
  const deduper = new IncidentDeduper({ cooldownMs: 60_000, now: () => now });
  const base = { workKey: 'channel:c1', incidentClass: 'STAGNATION', action: 'cmd:npm test', errorSignature: 'enoent', fingerprintHash: 'h1' };
  const signature = incidentSignature(base);
  assert.equal(deduper.shouldWake(signature).wake, true);
  deduper.record(signature);
  assert.equal(deduper.shouldWake(signature).wake, false, 'duplicate inside cooldown is suppressed');
  assert.equal(deduper.suppressedTotal, 1);
  now += 61_000;
  assert.equal(deduper.shouldWake(signature).wake, true, 'cooldown expiry allows a new evaluation');
  const changed = incidentSignature({ ...base, fingerprintHash: 'h2' });
  assert.notEqual(signature, changed, 'a progress change yields a new signature');
});

test('P3 dedupe: persisted snapshot restores suppression across a restart', () => {
  const base = { workKey: 'channel:c1', incidentClass: 'STAGNATION', action: 'a', errorSignature: 'e', fingerprintHash: 'h' };
  const signature = incidentSignature(base);
  const store = fakeStore();
  const first = newController({ store, policy: { maxWakes: 6, cooldownMs: 600_000 } });
  first.deduper.record(signature);
  first.persist();
  const second = newController({ store, policy: { maxWakes: 6, cooldownMs: 600_000 } });
  assert.equal(second.deduper.shouldWake(signature).wake, false, 'dedupe state resumes after restart');
});

// ----------------------------------------------------------- packet + parser

test('P3 packet: bounded, delta-only and secret-redacted', () => {
  const secret = 'sk-ABCDEFGH1234567890';
  const packet = buildIncidentPacket({
    workKey: 'channel:c1',
    contract: deriveWorkContract({ prompt: 'fix' }),
    incident: { class: 'STAGNATION', errorSignature: 'enoent', at: Date.now() },
    fingerprint: null,
    events: Array.from({ length: 50 }, (_, i) => ({ type: WORK_EVENT.TOOL_STARTED, action: `cmd:${i} ${secret}`, at: Date.now() })),
    maxChars: 900,
  });
  assert.ok(packet.text.length <= 900, 'packet is bounded');
  assert.equal(packet.truncated, true);
  assert.ok(!packet.text.includes(secret), 'secret-like fixture is redacted');
  assert.ok(packet.text.includes('INCIDENT CLASS'));
  assert.ok(packet.text.includes('LAST RELEVANT ACTIONS'));
});

test('P3 parser: strict bounded response; invalid output falls back to CONTINUE', () => {
  const good = parseReviewResponse('{"action":"SUGGEST_PAUSE_REPLAN","reason":"same failure","instruction":"verify ABI first","confidence":0.8}');
  assert.equal(good.ok, true);
  assert.equal(good.action, REVIEW_ACTION.SUGGEST_PAUSE_REPLAN);
  assert.equal(good.instruction, 'verify ABI first');
  const noisy = parseReviewResponse('Sure! {"action":"ASK_OWNER","reason":"needs a decision"}');
  assert.equal(noisy.ok, true);
  assert.equal(noisy.action, REVIEW_ACTION.ASK_OWNER);
  const bad = parseReviewResponse('{"action":"DELETE_EVERYTHING"}');
  assert.equal(bad.ok, false);
  assert.equal(bad.action, REVIEW_ACTION.CONTINUE, 'unknown action cannot become a side effect');
  assert.equal(parseReviewResponse('not json').ok, false);
});

test('P3 reviewer: resolves Grok 4.6 through discovery and marks DEGRADED when absent', () => {
  const provider = {
    id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
    billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
    models: [
      { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
      { id: 'grok-4.6', transport: TRANSPORT.OPENAI_RESPONSES },
    ],
  };
  const providerManager = { get: () => provider, hasCredential: () => true };
  const route = resolveTechLeadRoute({ providerManager, model: 'grok-4.6' });
  assert.equal(route.model, 'grok-4.6');
  assert.equal(route.transport, TRANSPORT.OPENAI_RESPONSES);

  const missing = { get: () => ({ ...provider, models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }] }), hasCredential: () => true };
  assert.equal(resolveTechLeadRoute({ providerManager: missing, model: 'grok-4.6' }), null);
  const reviewer = new TechLeadReviewer({ chatRuntime: { send: async () => ({ text: '{}' }) }, providerManager: missing, model: 'grok-4.6' });
  assert.equal(reviewer.status, 'DEGRADED');
});

// ----------------------------------------------------------- controller

test('P3 B/C: zero-token standby; exactly one startup review; failure fails open', async () => {
  const reviewer = fakeReviewer({ fail: true });
  const controller = newController({ reviewer });
  const begin = await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
  assert.equal(begin.started, true);
  assert.equal(controller.metrics.startupReviewCalls, 1);
  assert.equal(reviewer.calls, 1);
  assert.equal(controller.state, TECHLEAD_STATE.DEGRADED, 'a failing reviewer degrades without throwing');
  // Re-entering the same Work must not spend a second startup call.
  await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
  assert.equal(controller.metrics.startupReviewCalls, 1);
  // Long idle time with no event: no timer, no recurring/polling model call.
  await tick(60);
  assert.equal(reviewer.calls, 1, 'idle time must not increase the call count');
});

test('P3 D: stagnation wakes exactly one review and duplicates are suppressed', async () => {
  const reviewer = fakeReviewer({ action: REVIEW_ACTION.SUGGEST_PAUSE_REPLAN, reason: 'same xformers failure' });
  const controller = newController({ reviewer });
  await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
  await feedFailures(controller, { count: 3 });
  assert.equal(controller.metrics.incidentReviewCalls, 1, 'exactly one incident review');
  assert.equal(controller.work.lastIncident.class, INCIDENT_CLASS.STAGNATION);
  await controller.observe({ event: failed('enoent xformers') });
  assert.equal(controller.metrics.incidentReviewCalls, 1, 'duplicate incident inside cooldown is suppressed');
  assert.ok(controller.metrics.duplicateIncidentsSuppressed >= 1);
});

test('P3 E: budget cap stops further calls and reports BUDGET_EXHAUSTED', async () => {
  const reviewer = fakeReviewer({ action: REVIEW_ACTION.ASK_OWNER });
  const controller = newController({ reviewer, policy: { maxWakes: 2, cooldownMs: 60_000 } });
  await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
  await feedFailures(controller, { count: 3 }); // startup (1) + stagnation (2) = cap
  assert.equal(reviewer.calls, 2);
  assert.equal(controller.state, TECHLEAD_STATE.BUDGET_EXHAUSTED);
  // A different incident signature must also be refused.
  await controller.observe({ event: { type: WORK_EVENT.WORKER_MESSAGE, message: 'git reset --hard' } });
  assert.equal(reviewer.calls, 2, 'no further model calls after budget exhaustion');
  assert.match(controller.statusText(), /BUDGET_EXHAUSTED wakes=2\/2/);
});

test('P3 F: every valid action is advisory only; Shadow never invokes automation', async () => {
  const automation = { apply: async () => { throw new Error('automation must not run'); } };
  const actions = [REVIEW_ACTION.CONTINUE, REVIEW_ACTION.SUGGEST_INJECT, REVIEW_ACTION.SUGGEST_PAUSE_REPLAN, REVIEW_ACTION.ASK_OWNER];
  const delivered = [];
  for (const action of actions) {
    const reviewer = fakeReviewer({ action, reason: `advice ${action}`, instruction: 'do X' });
    const controller = newController({
      reviewer, automation, onAdvisory: (advisory) => { delivered.push(advisory); },
    });
    await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
    await feedFailures(controller, { count: 3 });
    assert.equal(controller.automatedActions.length, 0, `no automated action for ${action}`);
    const last = controller.advisories.at(-1);
    assert.equal(last.action, action);
    assert.equal(last.shadow, true);
    assert.equal(last.automated, false);
  }
  assert.deepEqual(delivered.map((item) => item.action), [
    REVIEW_ACTION.SUGGEST_INJECT, REVIEW_ACTION.SUGGEST_PAUSE_REPLAN, REVIEW_ACTION.ASK_OWNER,
  ], 'CONTINUE is record-only; material suggestions are shown');
});

test('P3 H: event capability probe reports FULL/PARTIAL/DEGRADED and falls back safely', async () => {
  assert.equal(detectEventVisibility({ structured: true }).status, EVENT_VISIBILITY.FULL);
  assert.equal(detectEventVisibility({ structured: false }).status, EVENT_VISIBILITY.PARTIAL);
  assert.equal(detectEventVisibility({}).status, EVENT_VISIBILITY.DEGRADED);
  assert.equal(detectEventVisibility({ executor: { available: true, capabilities: ['stream-json'], normalizeEvent: () => {} } }).status, EVENT_VISIBILITY.FULL);
  assert.equal(detectEventVisibility({ executor: { available: true, capabilities: [] } }).status, EVENT_VISIBILITY.PARTIAL);

  const controller = newController();
  await controller.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix', executor: { available: true, capabilities: [], normalizeEvent: () => {} } });
  assert.equal(controller.eventVisibility, EVENT_VISIBILITY.PARTIAL);
  assert.equal(controller.statusSnapshot().eventVisibility, EVENT_VISIBILITY.PARTIAL);
});

test('P3 I: restart resumes dedupe and a new Work resets the per-Work budget', async () => {
  const store = fakeStore();
  const reviewer = fakeReviewer({ action: REVIEW_ACTION.SUGGEST_PAUSE_REPLAN });
  const first = newController({ store, reviewer, policy: { maxWakes: 6, cooldownMs: 600_000 } });
  await first.beginWork({ channelId: 'c1', runId: 'r1', prompt: 'fix the build' });
  await feedFailures(first, { count: 3 });
  const incidentCallsAfterFirst = first.metrics.incidentReviewCalls;
  assert.equal(incidentCallsAfterFirst, 1);

  // Restart: same channel, a NEW run (new instance key) and a fresh reviewer.
  const reviewer2 = fakeReviewer({ action: REVIEW_ACTION.SUGGEST_PAUSE_REPLAN });
  const second = newController({ store, reviewer: reviewer2, policy: { maxWakes: 6, cooldownMs: 600_000 } });
  await second.beginWork({ channelId: 'c1', runId: 'r2', prompt: 'fix the build' });
  assert.equal(second.work.wakeCount, 1, 'new Work resets the per-Work budget to the startup call');
  await feedFailures(second, { count: 3 });
  const secondIncidentCalls = reviewer2._calls.filter((call) => call.kind === 'incident').length;
  assert.equal(secondIncidentCalls, 0, 'the unresolved incident is not re-billed after restart');
  assert.ok(second.metrics.duplicateIncidentsSuppressed >= 1);

  // Stale completed Work state does not leak: a new Work starts fresh.
  second.completeWork({ status: 'DONE' });
  await second.beginWork({ channelId: 'c1', runId: 'r3', prompt: 'fix the build' });
  assert.equal(second.work.completed, false);
  assert.equal(second.work.wakeCount, 1, 'budget reset for the new Work');
});

// ----------------------------------------------------------- integration

function makePlane({ techLead = null } = {}) {
  const fake = new FakeDiscord({ threadCapable: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p3-tl-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  state.patchChannel(fake.channelId, {
    mode: 'work', cwd: dir, executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash',
  }, dir);
  let release = () => {};
  const sendGate = new Promise((resolve) => { release = resolve; });
  const runner = {
    sessionId: 'sess-fixed', model: 'deepseek-v4.1-flash', busy: false, idleMs: 0, stopped: 0, sent: [], injected: [],
    release: () => release(),
    injectRequirement() { return { ok: false, delivered: false, reason: 'not-busy' }; },
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      await sendGate;
      this.busy = false;
      return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
    async stop() { this.stopped += 1; this.busy = false; release(); return { killed: true, pid: 1 }; },
  };
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [], get: () => null, hasCredential: () => true },
    executorManager: { list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [], resolveTransport: () => null, adapterLabel: () => null, supportsLiveSteering: () => true },
    modelManager: { list: async () => ({ models: [] }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    workspaceScheduler: new WorkspaceScheduler(),
    techLead,
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => { plane.runners.set(channelId, runner); return runner; };
  return { fake, plane, runner, dir };
}

test('P3 J: a Shadow advisory is displayed and the Worker is untouched', async (t) => {
  const reviewer = fakeReviewer({ action: REVIEW_ACTION.SUGGEST_PAUSE_REPLAN, reason: 'same failure with no progress', instruction: 'verify ABI first' });
  const techLead = new TechLeadController({
    reviewer, store: fakeStore(), policy: { maxWakes: 6, cooldownMs: 600_000 }, logger: { warn() {}, log() {} },
  });
  const { fake, plane, runner } = makePlane({ techLead });
  t.after(() => plane.delivery.stop());
  await plane.start();
  const ch = fake.channelId;

  const pending = fake.sendAsUser({ content: 'work fix the build' });
  assert.ok(await waitFor(() => plane.tasks.has(ch) && runner.busy), 'Work must reach RUNNING');
  assert.ok(await waitFor(() => techLead.metrics.startupReviewCalls === 1), 'startup review must run once');

  const toolEvent = { type: 'tool', tool: { name: 'Bash', input: { command: 'npm test' } } };
  const failEvent = { type: 'tool-result', text: 'Error: ENOENT xformers not found' };
  for (let i = 0; i < 3; i += 1) {
    plane.onRunnerEvent(ch, toolEvent);
    plane.onRunnerEvent(ch, failEvent);
    await waitFor(() => techLead.fingerprint.sameErrorCount === i + 1);
  }
  assert.ok(await waitFor(() => techLead.metrics.incidentReviewCalls === 1), 'one incident review');
  assert.ok(await waitFor(() => fake.messagesIn(ch).some((m) => /TechLead Shadow: SUGGEST_PAUSE_REPLAN/.test(m.content))), 'advisory is displayed');
  const advisory = fake.messagesIn(ch).find((m) => /TechLead Shadow/.test(m.content));
  assert.match(advisory.content, /Reason: same failure/);
  assert.match(advisory.content, /Suggested instruction: verify ABI first/);

  // Shadow safety: the Worker keeps running and is never stopped/injected by TechLead.
  assert.equal(runner.stopped, 0, 'TechLead must never stop the Worker');
  assert.deepEqual(runner.sent, ['fix the build'], 'TechLead must never inject a second requirement');
  assert.equal(techLead.automatedActions.length, 0);
  assert.equal(techLead.statusSnapshot().metrics.automated_actions, 0);
  runner.release();
  await pending;
});

test('P3 J: a disabled TechLead leaves Work behavior unchanged', async (t) => {
  const controller = new TechLeadController({ enabled: false, reviewer: fakeReviewer(), store: fakeStore() });
  const { fake, plane, runner } = makePlane({ techLead: controller });
  t.after(() => plane.delivery.stop());
  await plane.start();
  const pending = fake.sendAsUser({ content: 'work quick task' });
  assert.ok(await waitFor(() => runner.sent.length === 1), 'the Worker still runs when TechLead is disabled');
  await tick(30);
  assert.equal(controller.metrics.startupReviewCalls, 0);
  assert.equal(controller.metrics.incidentReviewCalls, 0);
  runner.release();
  await pending;
});
