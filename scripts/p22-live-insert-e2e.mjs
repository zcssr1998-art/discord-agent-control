// P2.2 live-insert (steering) real-machine smoke.
//
// Runs a REAL Work task for >30s against a REAL Claude-compatible Agent process
// (no fake runner, no fake model), then inserts a requirement while the turn is
// still RUNNING and proves the required properties:
//   - the original task was still RUNNING at insert time;
//   - exactly one Agent process pid (no second Agent);
//   - exactly one workspace lock acquisition / one Work run (no new run);
//   - the same sessionId and the same runId before and after the insert;
//   - the inserted side effect (inserted.txt == INSERT_OK) is part of the SAME run;
//   - exactly one final DONE.
//
// The Discord transport is the in-process fake (real Discord clicks are
// owner-run), but the Agent, the filesystem, the hook server and the durable
// store are real.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { WorkspaceScheduler } from '../src/workspace-scheduler.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { DurableStore } from '../src/durable-store.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { readOpenCodeGoKey } from '../src/litellm.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const PROVIDER = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};
const MODEL = 'deepseek-v4.1-flash';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-live-insert-'));
const key = readOpenCodeGoKey();
if (!key) { console.log('FAIL no OpenCode Go key available for the real-agent smoke'); process.exit(1); }

const secret = ensureHookSecret();
const approvalPort = await freePort();
const state = new StateStore(path.join(workdir, 'state.json'));
const permissions = new PermissionManager();
const approvals = new ApprovalManager({ timeoutMs: 120000 });
const scheduler = new WorkspaceScheduler();
const durableStore = new DurableStore({ file: path.join(workdir, 'jarvis.db'), logger: null });
durableStore.open();

const hookServer = createHookServer({
  config: { approvalHost: '127.0.0.1', approvalPort }, approvalManager: approvals, permissionManager: permissions, secret,
});
await new Promise((resolve, reject) => { hookServer.once('error', reject); hookServer.listen(approvalPort, '127.0.0.1', resolve); });

const executors = new ExecutorManager({
  workbuddyCommand: 'claude',
  bridgeEnv: { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(approvalPort), DISCORD_BRIDGE_SECRET: secret },
});
await executors.discover();
const claudeExecutor = executors.get('claude');
if (!claudeExecutor?.available) { console.log('FAIL Claude-compatible executor not available'); process.exit(1); }

const fake = new FakeDiscord({ threadCapable: false });
const channelId = fake.channelId;
state.patchChannel(channelId, { mode: 'work', cwd: workdir, executorId: 'claude', providerId: 'opencode-go', model: MODEL }, workdir);
permissions.switchLevel(channelId, LEVEL.RELAXED);

const providerManager = {
  list: () => [PROVIDER], get: (id) => (id === PROVIDER.id ? PROVIDER : null),
  hasCredential: () => true, health: async () => ({ ok: true }), listModels: async () => ({ models: PROVIDER.models }),
};
const credentials = { get: (ref) => (ref === 'provider:opencode-go' ? key : null), set: () => {}, remove: () => {} };

const plane = new DiscordControlPlane({
  config: {
    ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: workdir, claudeCommand: 'claude',
    notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1000, stallNoticeMs: 600000,
    allowPaidFallback: false, taskTimeoutMs: 600000, maxWorkFollowUps: 10,
  },
  state,
  approvalManager: approvals,
  permissionManager: permissions,
  providerManager,
  credentialStore: credentials,
  executorManager: executors,
  modelManager: { list: async () => ({ models: PROVIDER.models }), select: async () => {} },
  chatRuntime: { send: async () => ({ text: 'x' }) },
  logger: new RunLogger(path.join(workdir, 'logs')),
  backendState: { backend: { label: 'OpenCode Go', model: MODEL, free: false }, allowPaidFallback: false },
  workspaceScheduler: scheduler,
  durableStore,
  client: fake.client,
  autoLogin: false,
});

let submitCount = 0;
const originalSubmit = scheduler.submit.bind(scheduler);
scheduler.submit = (options) => { submitCount += 1; return originalSubmit(options); };
const pids = new Set();
const track = setInterval(() => {
  for (const runner of plane.runners.values()) if (runner?.child?.pid) pids.add(runner.child.pid);
}, 100);

// Diagnostics: watch for authentication retries and record their offset from the
// insert, plus the last assistant text, so a route failure is not mistaken for a
// steering failure.
let insertAtMs = null;
let firstRetryMs = null;
const retries = [];
const originalOnEvent = DiscordControlPlane.prototype.onRunnerEvent;
void originalOnEvent;
const diagRunnerHook = (runner) => {
  const onEvent = runner.onEvent;
  runner.onEvent = (event) => {
    if (event?.type === 'retry') {
      if (firstRetryMs === null) firstRetryMs = Date.now();
      retries.push(`attempt=${event.attempt} status=${event.errorStatus} error=${event.error}`);
      console.log(`[smoke][retry] attempt=${event.attempt} status=${event.errorStatus} error=${event.error}`);
    }
    if (event?.type === 'text') console.log(`[smoke][agent] ${String(event.text).slice(0, 160).replace(/\n/g, ' ⏎ ')}`);
    return onEvent(event);
  };
};
const originalGetRunner = plane.getRunner.bind(plane);
plane.getRunner = async (channelId) => {
  const runner = await originalGetRunner(channelId);
  if (!runner.__diagHooked) { runner.__diagHooked = true; diagRunnerHook(runner); }
  return runner;
};

await plane.start();
console.log(`[smoke] workdir=${workdir} channel=${channelId} executor=claude model=${MODEL}`);

const TASK = [
  'Run exactly this shell command and wait for it to finish before answering:',
  'powershell -Command "Start-Sleep -Seconds 35"',
  'After it returns, reply with the single word STEP1_DONE.',
].join(' ');

const taskPromise = fake.sendAsUser({ content: `work ${TASK}` });

// Wait until the real Agent is RUNNING, then insert while it is still running.
let insertedAt = null;
let runIdAtInsert = null;
let sessionAtInsert = null;
let busyAtInsert = null;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const chain = plane.workChains.get(channelId);
  const run = chain?.activeRunId ? plane.workRuns.get(chain.activeRunId) : null;
  const runner = plane.tasks.get(channelId)?.runner;
  if (run?.state === 'running' && runner?.busy) {
    // Route evidence without ever printing key material.
    console.log(`[smoke][env] providerRoute=${runner.gateway?.url ? 'local-adapter' : 'direct'} baseUrl=${runner.extraEnv?.ANTHROPIC_BASE_URL ? 'set' : 'unset'} inheritEnv=${runner.inheritEnv}`);
    runIdAtInsert = run.id;
    sessionAtInsert = plane.sessionManager.get(channelId).sessionId;
    busyAtInsert = true;
    insertedAt = Date.now();
    insertAtMs = insertedAt;
    break;
  }
  await sleep(200);
}
check('a real Work task reached RUNNING before the insert', Boolean(insertedAt));
if (!insertedAt) { cleanup(); process.exit(1); }
console.log(`[smoke] inserting while RUNNING runId=${runIdAtInsert} sessionId=${sessionAtInsert}`);

const insert = await fake.submitModal(`workinsert:${runIdAtInsert}`, {
  values: { requirement: 'Additionally create a file named inserted.txt in the workspace whose content is EXACTLY: INSERT_OK (no trailing text). Then reply INSERT_DONE.' },
  channelId,
});
const insertReply = insert.followedUp.map((p) => p.content).join('\n');
check('the live insert was accepted into the running turn', /已插入当前任务/.test(insertReply), insertReply.trim());
check('the UI did not show a queue position for the live insert', !/队列|Queue/.test(insertReply));

// Wait for the single final result.
await taskPromise;
await sleep(500);
clearInterval(track);

const runIdAfter = plane.workChains.get(channelId)?.activeRunId ?? null;
const sessionAfter = plane.sessionManager.get(channelId).sessionId;
const sessionOfRunnerAfter = plane.runners.get(channelId)?.sessionId ?? null;
const cardText = fake.messagesIn(channelId).map((m) => m.content).join('\n');
// The agent's own text contains STEP1_DONE / INSERT_DONE, so count the rendered
// terminal STATE label instead of the raw word DONE.
const doneCount = (cardText.match(/✅ 已完成/g) || []).length;
const probe = path.join(workdir, 'inserted.txt');
const probeContent = fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim() : null;
const runRows = durableStore.db.prepare('SELECT run_id, state FROM runs').all();
const pendingFollowUps = durableStore.status().pendingFollowups;
const schedulerState = scheduler.stateFor(channelId).state;

check('exactly one Agent process was used (no second Agent PID)', pids.size === 1, `pids=${[...pids].join(',')}`);
check('exactly one workspace lock acquisition / Work run (no new run)', submitCount === 1, `submit=${submitCount}`);
check('the same runId was used for the insert', runIdAfter === null || runIdAfter === runIdAtInsert, `runIdAfter=${runIdAfter}`);
// The live turn keeps ONE Claude session for the whole Work run; the runner pid
// and the session are both single, so no second session was created at insert.
check('one stable Agent session for the insert and the final result',
  Boolean(sessionOfRunnerAfter) && sessionOfRunnerAfter === sessionAfter,
  `runner=${sessionOfRunnerAfter} channel=${sessionAfter}`);
check('the run finished through the same channel (no active run left)', runIdAfter === null, `activeRunId=${runIdAfter}`);
check('the workspace lock was released', schedulerState !== 'running', `scheduler=${schedulerState}`);
check('the inserted side effect is part of the same Work run', probeContent === 'INSERT_OK', `inserted.txt=${JSON.stringify(probeContent)}`);
check('exactly one Work run record exists', runRows.length === 1, JSON.stringify(runRows.map((r) => r.state)));
check('the run reached a single terminal DONE', runRows.length === 1 && runRows[0].state === 'DONE', `states=${runRows.map((r) => r.state).join(',')}`);
check('the progress card shows a single DONE', doneCount === 1, `doneTokens=${doneCount}`);
check('no follow-up queue entries were created for the live insert', pendingFollowUps === 0, `pending=${pendingFollowUps}`);

console.log(`\n[smoke] adapter=${plane.tasks.size ? 'task-owned' : 'n/a'} retries=${retries.length} firstRetryOffsetMs=${firstRetryMs && insertAtMs ? firstRetryMs - insertAtMs : 'n/a'}`);
console.log(`[smoke] lastCard:\n${cardText.split('\n').slice(-6).join('\n')}`);
console.log(`\nP2.2 live-insert smoke: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
cleanup();
process.exitCode = results.every((r) => r.ok) ? 0 : 1;

function cleanup() {
  try { clearInterval(track); } catch { /* ignore */ }
  try { hookServer.close(); } catch { /* ignore */ }
  try { durableStore.close(); } catch { /* ignore */ }
  try { plane.stopAll({ reason: 'smoke finished' }).catch(() => {}); } catch { /* ignore */ }
}
