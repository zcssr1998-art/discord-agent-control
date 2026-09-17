// P2.2.4 Work lifecycle real-machine smoke (small and cheap).
//
// Real: OpenCode Go credential + Claude Code CLI (through the local
// Anthropic->OpenAI adapter), the real hook server, the real permission/store
// layers, the real DiscordControlPlane and the real Windows process tree.
// Fake: only the Discord transport (owner clicks are owner-run).
//
// Proves on the real machine:
//   L1. a running Work with a pending live insert + a queued continuation never
//       renders an intermediate DONE;
//   L2. the completed turn's result stays visible while the continuation runs;
//   L3. the consumed live insert is not later reported as unprocessed;
//   S1. ONE Stop press kills the real process tree and settles exactly once;
//   S2. a stale Stop control cannot affect anything afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { workControlRows } from '../src/discord/renderers.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function pidAlive(pid) {
  if (!pid) return false;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
    return stdout.includes(String(pid));
  } catch { return false; }
}

const PROVIDER = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};
const MODEL = 'deepseek-v4.1-flash';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p224-life-'));
const key = readOpenCodeGoKey();
if (!key) { console.log('FAIL no OpenCode Go key available for the real-agent smoke'); process.exit(1); }

const watchdog = setTimeout(() => { console.error('HARD_TIMEOUT'); process.exit(2); }, 420000);
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
if (!executors.get('claude')?.available) { console.log('FAIL Claude-compatible executor not available'); process.exit(1); }

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
    notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 300, stallNoticeMs: 600000,
    allowPaidFallback: false, taskTimeoutMs: 0, maxWorkFollowUps: 10,
  },
  state, approvalManager: approvals, permissionManager: permissions,
  providerManager, credentialStore: credentials, executorManager: executors,
  modelManager: { list: async () => ({ models: PROVIDER.models }), select: async () => {} },
  chatRuntime: { send: async () => ({ text: 'x' }) },
  logger: new RunLogger(path.join(workdir, 'logs')),
  backendState: { backend: { label: 'OpenCode Go', model: MODEL }, allowPaidFallback: false },
  workspaceScheduler: scheduler, durableStore, client: fake.client, autoLogin: false,
});
await plane.start();
console.log(`[smoke] workdir=${workdir} channel=${channelId} model=${MODEL}`);

const chain = () => plane.workChains.get(channelId);
const activeRun = () => { const c = chain(); return c?.activeRunId ? plane.workRuns.get(c.activeRunId) : null; };
const statusCard = () => plane.tasks.get(channelId)?.statusMessage ?? null;
const allText = () => fake.messagesIn(channelId).map((m) => m.content).join('\n');

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return true; await sleep(150); }
  return false;
}

// -------------------------------------------------------------- L1/L2/L3
const PART1 = [
  'Run exactly this shell command and wait for it to finish:',
  'powershell -Command "Start-Sleep -Seconds 12"',
  'Then reply with the single token FIRST_TURN_DONE.',
].join(' ');

let falseDone = false;
let sawContinuationRunning = false;
const monitor = setInterval(() => {
  const run = activeRun();
  const card = statusCard();
  if (!run || !card) return;
  if (!run.terminal && /✅ 已完成/.test(card.content)) falseDone = true;
  if (run.continuations.length === 0 && /正在执行|🟡/.test(card.content) && plane.tasks.has(channelId)) sawContinuationRunning = true;
}, 100);

const part1 = fake.sendAsUser({ content: `work ${PART1}` });
check('L1 a real Work task reached RUNNING', await waitFor(() => plane.tasks.has(channelId) && plane.tasks.get(channelId).runner?.busy, 90000));
const run1 = activeRun();
const runner1 = plane.tasks.get(channelId)?.runner;

// Live insert (steering on) while the turn is running.
const live = await fake.submitModal(`workinsert:${run1.id}`, {
  values: { requirement: 'Additionally create inserted-live.txt containing exactly LIVE_OK. Then reply LIVE_DONE.' },
  channelId,
});
check('L1 the live insert was accepted into the running turn', /已插入当前任务/.test(live.followedUp.map((p) => p.content).join('\n')));

// Force a same-run continuation through the production unsupported path: a
// queued continuation is what must block an intermediate DONE.
const originalSupports = executors.supportsLiveSteering.bind(executors);
executors.supportsLiveSteering = () => false;
const cont = await fake.submitModal(`workinsert:${run1.id}`, {
  values: { requirement: 'Then create continued.txt containing exactly CONTINUED_OK. Then reply CONTINUED_DONE.' },
  channelId,
});
executors.supportsLiveSteering = originalSupports;
check('L1 the queued continuation was accepted in the same run', /继续/.test(cont.followedUp.map((p) => p.content).join('\n')));
check('L1 no second Agent was started for the insert/continuation', scheduler.stateFor(channelId).state === 'running' && plane.runners.size === 1);

await part1;
await waitFor(() => !plane.tasks.has(channelId), 120000);
clearInterval(monitor);
await sleep(500);

check('L1 the card never claimed DONE while the Work was still running', !falseDone);
// Structural, model-agnostic: the completed turn must be preserved as its own
// message carrying the header AND the turn's real result text (which token the
// model emits is not deterministic and must not decide this check).
const turnResultMsg = fake.messagesIn(channelId).find((m) => /第 1 轮已完成/.test(m.content));
check('L2 the completed turn result is preserved as its own message',
  Boolean(turnResultMsg && /DONE/.test(turnResultMsg.content) && !/✅ 已完成/.test(turnResultMsg.content)),
  turnResultMsg ? turnResultMsg.content.split('\n').slice(-1)[0] : 'no turn-result message');
const doneTokens = (allText().match(/✅ 已完成/g) ?? []).length;
check('L1 exactly one terminal DONE for the whole Work', doneTokens === 1, `doneTokens=${doneTokens}`);
check('L3 the inserted side effect is part of the run', fs.existsSync(path.join(workdir, 'inserted-live.txt'))
  && fs.readFileSync(path.join(workdir, 'inserted-live.txt'), 'utf8').trim() === 'LIVE_OK');
check('L3 the continuation side effect is part of the run', fs.existsSync(path.join(workdir, 'continued.txt'))
  && fs.readFileSync(path.join(workdir, 'continued.txt'), 'utf8').trim() === 'CONTINUED_OK');
const insertRows = durableStore.db.prepare('SELECT state FROM queued_followups WHERE run_id = ?').all(run1.id);
const settledStates = new Set(insertRows.map((row) => row.state));
check('L3 the live insert settled as CONSUMED and the continuation as EXECUTED (neither pending)',
  insertRows.length >= 2 && settledStates.has('CONSUMED') && settledStates.has('EXECUTED')
  && ![...settledStates].some((s) => s === 'DELIVERED_LIVE' || s === 'QUEUED_CONTINUATION'),
  insertRows.map((row) => row.state).join(','));

// Stop after DONE must report no unprocessed insert.
await fake.sendAsUser({ content: '!stop' });
const afterDoneText = fake.messagesIn(channelId).at(-1).content;
check('L3 Stop after DONE does not claim any unprocessed insert', !/未处理的插入需求/.test(afterDoneText), afterDoneText.split('\n')[0]);

// -------------------------------------------------------------- S1/S2
const PART2 = [
  'Run exactly this shell command and wait for it:',
  'powershell -Command "Start-Sleep -Seconds 120"',
  'Then reply LONG_DONE.',
].join(' ');
const part2 = fake.sendAsUser({ content: `work ${PART2}` });
check('S1 a second real Work task is active', await waitFor(() => {
  const run = activeRun();
  return run && plane.tasks.get(channelId)?.runner?.busy;
}, 90000));
const run2 = activeRun();
const runner2 = plane.tasks.get(channelId)?.runner;
const pid = runner2?.child?.pid ?? null;

// A live insert exists when Stop lands.
await fake.submitModal(`workinsert:${run2.id}`, { values: { requirement: 'this insert must never run after Stop' }, channelId });

await fake.sendAsUser({ content: '!stop' });
const stopped = await waitFor(() => !plane.tasks.has(channelId) && !runner2?.busy, 30000);
check('S1 a single Stop released the task', stopped);
check('S1 the Agent process tree is really dead', pid != null && !(await pidAlive(pid)), `pid=${pid} alive=${await pidAlive(pid)}`);
check('S1 the real kill is reported once', /已停止 Agent 进程树（pid/.test(allText()), `stopped=${runner2?.stopped ?? 0}`);
check('S1 the run reached STOPPED once', /已停止/.test(allText()) || runner2?.stopped === true);
const card2 = statusCard();
check('S1 the terminal card exposes no live controls', !card2 || card2.buttonIds.filter((id) => id.startsWith('workctl:')).length === 0);
check('S1 no run left after Stop', plane.workRuns.size === 0, `workRuns=${plane.workRuns.size}`);
void part2;

// Stale control from the stopped run cannot do anything.
const stoppedRunner = runner2?.stopped ?? 0;
const stale = await fake.channel.send({ content: 'stale card', components: workControlRows(run2.id) });
check('S2 a stale card can be re-materialised', Boolean(stale));
const click = await fake.clickButton(`workctl:stop:${run2.id}`).catch((error) => ({ error }));
const staleReply = click?.error ? String(click.error.message) : String(click.interaction.replied?.content ?? '');
check('S2 the stale Stop is rejected idempotently', /该任务已结束|no message carries/.test(staleReply), staleReply.slice(0, 60));
check('S2 no new Agent/run was created by the stale Stop', plane.workRuns.size === 0 && plane.runners.size === 0 && (runner2?.stopped ?? 0) === stoppedRunner);

await plane.stopAll({ reason: 'p224 smoke done' });
hookServer.close();
durableStore.close();
clearTimeout(watchdog);

const failed = results.filter((item) => !item.ok);
console.log(`\n=== P2.2.4 lifecycle smoke: ${results.length - failed.length}/${results.length} passed ===`);
for (const item of failed) console.log(`FAILED: ${item.name} ${item.detail}`);
console.log(`artifacts: ${workdir}`);
process.exitCode = failed.length ? 1 : 0;

function cleanup() {
  try { clearInterval(monitor); } catch { /* ignore */ }
  try { clearTimeout(watchdog); } catch { /* ignore */ }
  try { hookServer.close(); } catch { /* ignore */ }
  try { durableStore.close(); } catch { /* ignore */ }
  try { plane.stopAll({ reason: 'cleanup' }).catch(() => {}); } catch { /* ignore */ }
}
process.on('exit', cleanup);
void root;
