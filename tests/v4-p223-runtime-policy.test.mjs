/**
 * P2.2.3 blocking addendum K4/K5:
 *   K4 — FULL must be a real no-routine-approval policy, and a Work thread must
 *        inherit the parent's effective level exactly (including FULL).
 *   K5 — production Work has NO default wall-clock cap; duration alone never
 *        kills a live task. An explicit positive operator limit still works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { createHookServer } from '../src/hook-server.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://example.invalid/v1', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [{ id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT }],
};

function makePlane({ taskTimeoutMs = 0, sendDelayMs = 0 } = {}) {
  const fake = new FakeDiscord({ threadCapable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-policy-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  const providers = {
    list: () => [OPENCODE_GO], get: (id) => (id === OPENCODE_GO.id ? OPENCODE_GO : null), hasCredential: () => true,
  };
  const executorManager = {
    list: () => [], get: () => null, compatible: () => true, compatibleExecutors: () => [],
    resolveTransport: () => TRANSPORT.OPENAI_CHAT, adapterLabel: () => null,
  };
  const calls = { runner: null, stops: [] };
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs, maxWorkFollowUps: 10,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    modelManager: { select: async () => {}, list: async () => ({ models: OPENCODE_GO.models }) },
    executorManager,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: 'deepseek-v4.1-flash' }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.getRunner = async (channelId) => {
    const runner = {
      sessionId: `sess-${channelId}`, model: 'deepseek-v4.1-flash', busy: false, stopped: false, idleMs: 0, lastError: null,
      async send(prompt) {
        this.busy = true;
        plane.onRunnerEvent(channelId, { type: 'session', sessionId: this.sessionId });
        if (sendDelayMs) await tick(sendDelayMs);
        this.busy = false;
        return { text: `done:${prompt}`, sessionId: this.sessionId, durationMs: sendDelayMs, tools: [], isError: false, costUsd: 0 };
      },
      async stop({ reason } = {}) { this.stopped = true; this.busy = false; calls.stops.push(reason ?? null); },
    };
    calls.runner = runner;
    // Mirror the real getRunner: the stop path looks the runner up by channel.
    plane.runners.set(channelId, runner);
    return runner;
  };
  return { fake, plane, calls };
}

// --------------------------------------------------------------------- K4

test('K4: a Work thread created from a FULL parent inherits FULL, not STANDARD', async (t) => {
  const { fake, plane, calls } = makePlane();
  await plane.start();
  t.after(() => plane.stopAll({ reason: 'test' }));

  // Owner confirms FULL once in the parent channel.
  plane.permissionManager.confirmFull(fake.channelId);
  assert.equal(plane.permissionManager.getLevel(fake.channelId), LEVEL.FULL);

  await fake.sendAsUser({ content: 'work representative multi-step repo task', guildId: 'guild-1' });
  const thread = fake.threads[0];
  assert.ok(thread, 'a Work thread must have been created');

  assert.equal(plane.permissionManager.getLevel(thread.id), LEVEL.FULL, 'the child thread must not silently fall back to STANDARD');
  assert.equal(plane.permissionManager.getLevelBySession(calls.runner.sessionId), LEVEL.FULL, 'the run session must be bound to the same level');

  // No second confirmation was requested; inheritance is a direct copy.
  const child = plane.permissionManager.inheritLevel('fresh-child', LEVEL.FULL);
  assert.equal(child.ok, true);
  assert.equal(child.changed, true);
  assert.equal(plane.permissionManager.getLevel('fresh-child'), LEVEL.FULL);
});

test('K4: FULL + representative tool calls produce zero approval prompts at the real hook gate', async (t) => {
  const { fake, plane } = makePlane();
  await plane.start();
  t.after(() => plane.stopAll({ reason: 'test' }));

  plane.permissionManager.confirmFull(fake.channelId);
  await fake.sendAsUser({ content: 'work another repo task', guildId: 'guild-1' });
  const thread = fake.threads[0];
  const sessionId = `sess-${thread.id}`;
  assert.equal(plane.permissionManager.getLevelBySession(sessionId), LEVEL.FULL);

  let prompts = 0;
  const approvals = new ApprovalManager({ timeoutMs: 500 });
  approvals.setPresenter((req) => { prompts += 1; approvals.resolve(req.id, 'deny'); });
  const config = { defaultCwd: process.cwd(), autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
  const server = createHookServer({ config, approvalManager: approvals, permissionManager: plane.permissionManager, secret: 'k4-secret' });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const call = async (toolName, toolInput) => {
    const response = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k4-secret' },
      body: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: process.cwd(), session_id: sessionId }),
    });
    return (await response.json()).hookSpecificOutput.permissionDecision;
  };

  // Representative Work calls that used to raise approval cards under FULL.
  assert.equal(await call('Bash', { command: 'grep -R "config" .' }), 'allow');
  assert.equal(await call('Bash', { command: 'git config --list' }), 'allow');
  assert.equal(await call('Bash', { command: 'echo $PATH' }), 'allow');
  assert.equal(await call('Read', { file_path: path.join(os.homedir(), '.config', 'x.ini') }), 'allow');
  assert.equal(await call('Write', { file_path: path.join(os.tmpdir(), 'outside-workspace.txt') }), 'allow');
  assert.equal(await call('mcp__everything__use', {}), 'allow');
  // The deterministic hard guard still holds under FULL.
  assert.equal(await call('Bash', { command: 'git add .env' }), 'deny');
  assert.equal(prompts, 0, 'FULL must not surface routine approval prompts');
});

test('K4: the user-facing FULL switch still requires an explicit confirmation', () => {
  const permissions = new PermissionManager();
  const pending = permissions.switchLevel('c1', LEVEL.FULL);
  assert.equal(pending.needsConfirm, true, 'a user-facing switch into FULL needs confirmation');
  assert.equal(pending.ok, false);
  assert.equal(permissions.getLevel('c1'), LEVEL.STANDARD, 'FULL must not be applied before confirmation');
  permissions.confirmFull('c1');
  assert.equal(permissions.getLevel('c1'), LEVEL.FULL);
});

// --------------------------------------------------------------------- K5

test('K5: with no configured cap a slow-but-healthy task is never killed', async (t) => {
  const { fake, plane, calls } = makePlane({ taskTimeoutMs: 0, sendDelayMs: 150 });
  await plane.start();
  t.after(() => plane.stopAll({ reason: 'test' }));

  await fake.sendAsUser({ content: 'work long healthy task', guildId: 'guild-1' });
  const thread = fake.threads[0];
  assert.equal(calls.runner.stopped, false, 'duration alone must not stop the Agent');
  assert.deepEqual(calls.stops, []);
  const text = fake.messagesIn(thread.id).map((m) => m.content).join('\n');
  assert.match(text, /✅ 已完成/);
  assert.doesNotMatch(text, /执行超时|达到时间上限/);
});

test('K5: an explicit positive TASK_TIMEOUT_MS is still honored as an opt-in operator limit', async (t) => {
  const { fake, plane, calls } = makePlane({ taskTimeoutMs: 40, sendDelayMs: 250 });
  await plane.start();
  t.after(() => plane.stopAll({ reason: 'test' }));

  await fake.sendAsUser({ content: 'work over-limit task', guildId: 'guild-1' });
  const thread = fake.threads[0];
  assert.equal(calls.runner.stopped, true, 'an explicit operator limit must stop the Agent');
  assert.ok(calls.stops.some((reason) => /wall-clock timeout/.test(String(reason))));
  const text = fake.messagesIn(thread.id).map((m) => m.content).join('\n');
  assert.match(text, /时间上限|执行超时/);
});

test('K5: an owner Stop still terminates the real run promptly under unlimited mode', async (t) => {
  const { fake, plane, calls } = makePlane({ taskTimeoutMs: 0, sendDelayMs: 1500 });
  await plane.start();
  t.after(() => plane.stopAll({ reason: 'test' }));

  // Do not await the send: the task keeps running while we stop it.
  const sending = fake.sendAsUser({ content: 'work stop-me task', guildId: 'guild-1' });
  for (let i = 0; i < 100 && !plane.tasks.has(fake.threads[0]?.id); i += 1) await tick(10);
  const thread = fake.threads[0];
  assert.ok(thread, 'the Work thread exists');
  assert.ok(plane.tasks.has(thread.id), 'the run is active before Stop');

  // `!stop` inside the thread must stop the real runner.
  await fake.sendAsUser({ content: '!stop', channelId: thread.id, guildId: 'guild-1' });
  await sending.catch(() => {});
  assert.equal(calls.runner.stopped, true, 'Stop must control the real process');
});
