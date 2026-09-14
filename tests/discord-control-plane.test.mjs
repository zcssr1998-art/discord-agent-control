import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { STATE } from '../src/progress.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makePlane({ sendImpl, approvals, throttleMs = 10_000, config = {} } = {}) {
  const fake = new FakeDiscord();
  const state = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dac-ui-')), 'state.json'));
  const manager = approvals ?? new ApprovalManager({ timeoutMs: 5000 });
  const plane = new DiscordControlPlane({
    config: {
      discordToken: 'x',
      ownerId: fake.ownerId,
      guildId: null,
      channelId: null,
      claudeCommand: 'claude',
      defaultCwd: process.cwd(),
      approvalHost: '127.0.0.1',
      approvalPort: 1,
      approvalTimeoutMs: 5000,
      autoAllowWorkspaceWrites: true,
      autoAllowTestCommands: true,
      includePartialMessages: false,
      progressThrottleMs: throttleMs,
      notifyOnStart: false,
      logDir: null,
      agentBackend: 'workbuddy-free-dsf',
      allowPaidFallback: false,
      taskTimeoutMs: 60_000,
      maxConsecutiveFailures: 3,
      maxProcessRestarts: 5,
      ...config,
    },
    state,
    approvalManager: manager,
    routing: { env: {}, source: 'process-env', added: [] },
    backendState: {
      backend: { id: 'workbuddy-free-dsf', label: 'WorkBuddy Free DSF', apiKeySource: 'www.workbuddy.ai', model: 'fast-model', free: true },
      allowPaidFallback: false,
      billingRoute: 'WorkBuddy Free',
      executor: 'codebuddy',
    },
    client: fake.client,
    autoLogin: false,
  });

  // Replace the real Claude process with a scripted one; everything else in the
  // control plane (commands, progress, approvals, session bookkeeping) stays real.
  const fakeRunner = {
    sessionId: 'sess-1',
    model: 'deepseek-flash[1m]',
    busy: false,
    stopped: false,
    sent: [],
    idleMs: 0,
    async send(prompt) {
      this.busy = true;
      this.sent.push(prompt);
      this.onEvent({ type: 'session', sessionId: this.sessionId });
      this.onEvent({ type: 'init', model: this.model, apiKeySource: 'www.workbuddy.ai', tools: ['Read'] });
      try {
        if (sendImpl) return await sendImpl({ prompt, plane, runner: this, approvals: manager, fake });
        this.onEvent({ type: 'tool', tool: { name: 'Read', input: { file_path: 'src/a.js' } } });
        return { text: 'all done', sessionId: this.sessionId, durationMs: 1200, tools: [], isError: false, costUsd: 0.0123 };
      } finally {
        // Mirrors the real runner, whose `busy` is derived from the in-flight
        // request: a finished (or failed) run must not leave the channel busy.
        this.busy = false;
      }
    },
    async stop() { this.stopped = true; this.busy = false; },
    onEvent: () => {},
  };
  plane.getRunner = () => fakeRunner;
  plane.runners.set(fake.channelId, fakeRunner);
  // Wire the scripted runner to the real event pipeline, exactly like the real
  // getRunner does, so progress/state bookkeeping is genuinely exercised.
  fakeRunner.onEvent = (event) => plane.onRunnerEvent(fake.channelId, event);
  return { fake, plane, runner: fakeRunner, approvals: manager };
}

test('only the configured owner can drive the agent', async () => {
  const { fake, plane } = makePlane();
  await plane.start();

  await fake.sendAsUser({ content: 'hello', authorId: 'intruder' });
  assert.equal(fake.messages.length, 0, 'non-owner messages must be ignored');

  await fake.sendAsUser({ content: '!status' });
  assert.equal(fake.messages.length, 1, 'owner messages are handled');
  const status = fake.messages[0].content;
  assert.match(status, /Backend: WorkBuddy Free DSF/);
  assert.match(status, /Billing route: WorkBuddy Free/);
  assert.match(status, /Paid fallback: disabled/);
  assert.match(status, /Model: deepseek-flash\[1m\]/);
  assert.ok(!/^DeepSeek$/m.test(status), 'the backend must not be reported as a bare "DeepSeek"');
});

test('a task produces one low-noise status message, not a log flood', async () => {
  const { fake, plane } = makePlane({
    sendImpl: async ({ runner }) => {
      for (let i = 0; i < 20; i += 1) {
        runner.onEvent({ type: 'tool', tool: { name: 'Edit', input: { file_path: `src/file${i}.js` } } });
      }
      runner.onEvent({ type: 'tool', tool: { name: 'Bash', input: { command: 'npm test' } } });
      runner.onEvent({ type: 'text', text: '# tests 12\n# pass 12\n# fail 0' });
      return { text: 'Added the health endpoint and committed.', sessionId: 'sess-1', durationMs: 4200, tools: [], isError: false, costUsd: 0.03 };
    },
  });
  await plane.start();
  await fake.sendAsUser({ content: 'add a health endpoint' });

  const status = fake.messages[0];
  assert.ok(status, 'a status message must be created');
  assert.ok(status.edits <= 3, `expected a handful of edits, got ${status.edits} for 21 tool events`);
  assert.match(status.content, /✅ DONE/);
  assert.match(status.content, /Added the health endpoint and committed\./);
  assert.match(status.content, /Tools: Edit ×20 · Bash ×1/);
  assert.match(status.content, /Tests: passed \(12\)/);
});

test('a second task is refused while one is running', async () => {
  const { fake, plane, runner } = makePlane({
    sendImpl: async () => {
      runner.busy = true;
      await tick(60);
      return { text: 'slow', sessionId: 'sess-1', durationMs: 60, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();
  const first = fake.sendAsUser({ content: 'task one' });
  await tick(10);
  await fake.sendAsUser({ content: 'task two' });
  await first;

  assert.ok(fake.texts().some((t) => /already running/.test(t)), 'the second task must be refused');
});

test('an approval request appears in the channel and the button really resolves it', async () => {
  let pending = null;
  const { fake, plane, approvals } = makePlane({
    sendImpl: async ({ runner }) => {
      runner.onEvent({ type: 'tool', tool: { name: 'Bash', input: { command: 'rm -rf build' } } });
      // The real hook server calls this and blocks until the phone answers.
      pending = approvals.request({
        sessionId: 'sess-1',
        ruleKey: 'bash-destructive',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        cwd: process.cwd(),
        reason: 'destructive or irreversible shell command',
      });
      const answer = await pending;
      runner.onEvent({ type: 'text', text: `approval=${answer.decision}` });
      return { text: `approval=${answer.decision}`, sessionId: 'sess-1', durationMs: 500, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();
  const task = fake.sendAsUser({ content: 'clean the build dir' });
  await tick(60);

  const approvalMsg = fake.approvalMessage('allow-once');
  assert.ok(approvalMsg, 'an approval message with buttons must be posted');
  assert.equal(approvalMsg.channelId, fake.channelId, 'approval goes to the originating channel');
  assert.deepEqual(
    approvalMsg.buttonIds.map((id) => id.split(':').pop()).sort(),
    ['allow-once', 'allow-session', 'deny'],
  );
  assert.match(approvalMsg.content, /destructive or irreversible shell command/);

  const status = fake.messages[0];
  assert.match(status.content, /🔐 WAITING_APPROVAL/, 'status must show WAITING_APPROVAL while blocked');

  const onceId = approvalMsg.buttonIds.find((id) => id.endsWith(':allow-once'));
  await fake.clickButton(onceId);
  const answer = await pending;
  assert.equal(answer.decision, 'allow');
  await task;

  assert.match(status.content, /✅ DONE/);
  assert.match(status.content, /approval=allow/);
  assert.match(approvalMsg.content, /Decision: ✅ Allow once/);
});

test('deny from the phone propagates as a deny to the waiting agent', async () => {
  let pending = null;
  const { fake, plane, approvals } = makePlane({
    sendImpl: async ({ runner }) => {
      pending = approvals.request({
        sessionId: 'sess-1', ruleKey: 'bash-destructive', toolName: 'Bash',
        toolInput: { command: 'rm -rf build' }, cwd: process.cwd(), reason: 'destructive',
      });
      const answer = await pending;
      return { text: `approval=${answer.decision}`, sessionId: 'sess-1', durationMs: 100, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();
  const task = fake.sendAsUser({ content: 'clean' });
  await tick(60);

  const denyId = fake.approvalMessage('deny').buttonIds.find((id) => id.endsWith(':deny'));
  await fake.clickButton(denyId);
  assert.equal((await pending).decision, 'deny');
  await task;
  assert.match(fake.messages[0].content, /approval=deny/);
});

test('a stranger cannot press the approval buttons', async () => {
  const { fake, plane, approvals } = makePlane();
  await plane.start();
  const p = approvals.request({
    sessionId: 'sess-1', ruleKey: 'bash-network', toolName: 'Bash',
    toolInput: { command: 'curl x' }, cwd: process.cwd(), reason: 'network',
  });
  await tick(40);
  const btn = fake.approvalMessage('allow-once');
  assert.ok(btn);

  const { interaction } = await fake.clickButton(btn.buttonIds[0], { userId: 'intruder' });
  assert.match(interaction.replied.content, /Not authorized/);
  assert.equal(approvals.pending.size, 1, 'the request must still be pending');

  approvals.cancelForSession(null, 'cleanup');
  assert.equal((await p).decision, 'deny');
});

test('!stop cancels a pending approval instead of leaving the agent hanging', async () => {
  let pending = null;
  const { fake, plane, approvals, runner } = makePlane({
    sendImpl: async () => {
      pending = approvals.request({
        sessionId: 'sess-1', ruleKey: 'bash-destructive', toolName: 'Bash',
        toolInput: { command: 'rm -rf x' }, cwd: process.cwd(), reason: 'destructive',
      });
      const answer = await pending;
      return { text: `approval=${answer.decision}`, sessionId: 'sess-1', durationMs: 10, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();
  const task = fake.sendAsUser({ content: 'clean' });
  await tick(60);
  assert.equal(approvals.pending.size, 1);

  await fake.sendAsUser({ content: '!stop' });
  assert.equal((await pending).decision, 'deny');
  assert.equal(runner.stopped, true);
  await task;
  assert.ok(fake.texts().some((t) => /Cancelled 1 pending approval/.test(t)));
});

test('!reset clears the session and re-arms session approvals', async () => {
  const { fake, plane, approvals } = makePlane();
  await plane.start();
  approvals.allowForSession('sess-1', 'bash-network');

  await fake.sendAsUser({ content: '!reset' });
  assert.equal(approvals.isSessionAllowed('sess-1', 'bash-network'), false, 'reset must re-arm the gate');

  await fake.sendAsUser({ content: '!status' });
  const last = fake.messages[fake.messages.length - 1];
  assert.match(last.content, /session: `new`/);
});

test('!cwd rejects bad paths and accepts a real absolute path', async () => {
  const { fake, plane } = makePlane();
  await plane.start();

  await fake.sendAsUser({ content: '!cwd relative/path' });
  assert.match(fake.messages.at(-1).content, /existing absolute path/);

  await fake.sendAsUser({ content: '!cwd C:\\definitely\\not\\here\\nope' });
  assert.match(fake.messages.at(-1).content, /existing absolute path/);

  await fake.sendAsUser({ content: `!cwd ${os.tmpdir()}` });
  assert.match(fake.messages.at(-1).content, /Bound this Discord channel/);
});

test('!handoff produces a compact escalation package', async () => {
  const { fake, plane } = makePlane();
  await plane.start();
  await fake.sendAsUser({ content: '!handoff' });
  const text = fake.messages.at(-1).content;
  assert.match(text, /目标:/);
  assert.match(text, /项目:/);
  assert.match(text, /需要判断:/);
});

test('the owner is told the bridge is online, because Discord does not replay offline messages', async () => {
  const { fake, plane } = makePlane({ config: { notifyOnStart: true } });
  await plane.start();
  const dm = fake.messages.find((m) => m.kind === 'dm');
  assert.ok(dm, 'a ready DM must be sent to the owner');
  assert.match(dm.content, /Bridge ready/);
  assert.match(dm.content, /Backend: WorkBuddy Free DSF/);
  assert.match(dm.content, /Billing route: WorkBuddy Free/);
  assert.match(dm.content, /Paid fallback: DISABLED/);
  assert.equal(fake.ownerDmCount, 1, 'exactly one ready DM, not a stream of them');
});

test('a failing agent surfaces FAILED instead of a silent success', async () => {
  const { fake, plane } = makePlane({
    sendImpl: async () => { throw new Error('Claude exited code=1 signal='); },
  });
  await plane.start();
  await fake.sendAsUser({ content: 'do something' });
  const status = fake.messages[0];
  assert.match(status.content, /❌ FAILED/);
  assert.match(status.content, /Claude exited code=1/);
});

test('a pre-existing session is resumed and the model is persisted', async () => {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-ui-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  state.patchChannel(fake.channelId, { sessionId: 'old-session', cwd: os.tmpdir() }, os.tmpdir());

  const plane = new DiscordControlPlane({
    config: {
      discordToken: 'x', ownerId: fake.ownerId, guildId: null, channelId: null,
      claudeCommand: 'claude', defaultCwd: os.tmpdir(), approvalHost: '127.0.0.1', approvalPort: 1,
      approvalTimeoutMs: 5000, autoAllowWorkspaceWrites: true, autoAllowTestCommands: true,
      includePartialMessages: false, progressThrottleMs: 1000, notifyOnStart: false, logDir: null,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    client: fake.client,
    autoLogin: false,
  });
  const seen = [];
  plane.getRunner = (channelId) => {
    seen.push(state.getChannel(channelId, os.tmpdir()).sessionId);
    return { sessionId: 'old-session', model: null, busy: false, onEvent: () => {}, async send() { return { text: 'ok', sessionId: 'old-session', durationMs: 1, tools: [], isError: false }; }, async stop() {} };
  };
  await plane.start();
  await fake.sendAsUser({ content: 'continue where we left off' });
  assert.equal(seen[0], 'old-session', 'the persisted session must be resumed after a restart');
});

// ---------------------------------------------------------------------------
// Regression: the 2026-09-14 outage.
//
// The acceptance criterion for the whole product is one sentence: no matter how
// badly the agent / PowerShell / shell wedges, the Discord control plane must
// stay reachable. `!status` and `!stop` have to work while a task is stuck.
// ---------------------------------------------------------------------------

test('a wedged agent cannot take the control plane down: !status and !stop still answer', async () => {
  let release;
  let call = 0;
  const { fake, plane, runner } = makePlane({
    sendImpl: async () => {
      call += 1;
      if (call === 1) return await new Promise((resolve) => { release = resolve; });
      return { text: 'after stop ok', sessionId: 'sess-1', durationMs: 5, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();

  const task = fake.sendAsUser({ content: 'wedge the agent' });
  await tick(60);

  // The agent is now silent: no tool events, no result, no exit. Before the fix
  // the status message sat on a stale RUNNING and the channel never recovered.
  const started = Date.now();
  await fake.sendAsUser({ content: '!status' });
  assert.ok(Date.now() - started < 2000, '!status must answer while a task is wedged');
  assert.ok(fake.texts().some((t) => /state: busy/.test(t)), '!status must report the wedged task');

  await fake.sendAsUser({ content: '!stop' });
  assert.ok(runner.stopped, '!stop must actually kill the agent');
  assert.ok(
    fake.texts().some((t) => /Stopped the agent process tree|released/.test(t)),
    '!stop must confirm the stop',
  );
  assert.equal(plane.tasks.size, 0, 'the busy state must be released by !stop');
  assert.equal(plane.runners.size, 0, 'the runner must be dropped so a new task can start');

  // A late result must not be presented as a success after the stop.
  release({ text: 'late result', sessionId: 'sess-1', durationMs: 1, tools: [], isError: false, costUsd: 0 });
  await task;
  assert.ok(
    fake.messages.some((m) => /⛔ CANCELLED/.test(m.content)),
    'the status must land on CANCELLED, never on RUNNING or DONE',
  );

  // The channel must be usable again straight away.
  await fake.sendAsUser({ content: 'after stop' });
  assert.ok(fake.texts().some((t) => /after stop ok/.test(t)), 'the next task must run normally');
});

test('a silent agent gets a "still waiting" notice without spending a model call', async () => {
  let release;
  const { fake, plane, runner } = makePlane({
    throttleMs: 10,
    config: { stallNoticeMs: 200 },
    sendImpl: async ({ runner: r }) => {
      // Reproduce the field state: four PowerShell calls done, then silence.
      r.onEvent({ type: 'tool', tool: { name: 'PowerShell', input: { command: 'Set-ItemProperty ... Wallpaper' } } });
      r.onEvent({ type: 'tool', tool: { name: 'PowerShell', input: { command: 'Set-ItemProperty ... WallpaperStyle' } } });
      // Pretend the agent has produced nothing for a minute.
      r.idleMs = 60_000;
      return await new Promise((resolve) => { release = resolve; });
    },
  });
  await plane.start();

  fake.sendAsUser({ content: 'silent task' });
  await tick(1400);

  const status = fake.messages[0];
  assert.match(status.content, /仍在等待 PowerShell/, 'the phone must be told what the agent is stuck on');
  assert.match(status.content, /Last action: PowerShell/, 'and what it is waiting on');
  assert.equal(runner.sent.length, 1, 'the watchdog must never send another prompt to the model');

  release({ text: 'finally done', sessionId: 'sess-1', durationMs: 1, tools: [], isError: false, costUsd: 0 });
  await tick(60);
});

test('an agent that dies without a result ends FAILED and the channel stays usable', async () => {
  let call = 0;
  const { fake, plane } = makePlane({
    sendImpl: async () => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error('agent process exited without producing a result'), { code: 'AGENT_EXIT_NO_RESULT' });
      }
      return { text: 'recovered', sessionId: 'sess-1', durationMs: 1, tools: [], isError: false, costUsd: 0 };
    },
  });
  await plane.start();

  await fake.sendAsUser({ content: 'wedge' });
  assert.match(fake.messages[0].content, /❌ FAILED/, 'a dead agent must produce FAILED, not a permanent RUNNING');
  assert.equal(plane.tasks.size, 0, 'the task must be released');

  await fake.sendAsUser({ content: 'try again' });
  assert.ok(fake.texts().some((t) => /recovered/.test(t)), 'the channel must accept the next task');
});

test('shutdown reaps every live agent tree so no orphan PowerShell survives', async () => {
  const { plane, runner } = makePlane({
    sendImpl: async () => await new Promise(() => {}),
  });
  await plane.start();
  runner.busy = true;

  const stopped = await plane.stopAll({ reason: 'bridge shutdown' });
  assert.equal(stopped, 1, 'every runner must be stopped');
  assert.ok(runner.stopped, 'the agent tree must be killed');
  assert.equal(plane.runners.size, 0);
  assert.equal(plane.tasks.size, 0, 'no task may be left behind on shutdown');
});

