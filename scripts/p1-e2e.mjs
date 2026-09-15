#!/usr/bin/env node
/**
 * Real-machine P1 smoke — workspace queue, Work threads, cancel semantics.
 *
 * Real: Claude Code CLI (through the local Anthropic <-> OpenAI adapter to
 * OpenCode Go), the PreToolUse hook server, the policy, ApprovalManager,
 * PermissionManager, ExecutorManager, ProviderManager, the real
 * DiscordControlPlane, the WorkspaceScheduler, git and the filesystem.
 * Fake: the Discord transport only (tests/helpers/fake-discord.mjs), because the
 * bridge cannot drive real Discord (it deliberately ignores bot-authored
 * messages, so it cannot send as the human owner).
 *
 *   node scripts/p1-e2e.mjs
 *
 * This is the machine-side companion to the human real-Discord smoke. It does
 * not replace the two-context real Discord smoke, which still needs the owner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ProviderManager } from '../src/provider-manager.mjs';
import { CredentialStore } from '../src/credential-store.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { readOpenCodeGoKey } from '../src/litellm.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const MODEL = process.env.P1_SMOKE_MODEL || 'deepseek-v4.1-flash';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hard watchdog: a wedged agent must fail the smoke, never hang it forever.
const watchdog = setTimeout(() => { console.error('HARD_TIMEOUT'); process.exit(2); }, 300000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p1-e2e-'));

function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'smoke@local'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'P1 Smoke'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# p1 smoke\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'chore: init'], { cwd: dir });
  return dir;
}

async function makePlane({ executors, providers, credentials, repo, channels, threadCapable = false }) {
  const secret = ensureHookSecret();
  const approvals = new ApprovalManager({ timeoutMs: 60000 });
  approvals.setPresenter((req) => approvals.resolve(req.id, 'allow-once'));
  const permissions = new PermissionManager();
  const hookServer = createHookServer({
    config: { defaultCwd: repo, autoAllowWorkspaceWrites: true, autoAllowTestCommands: true },
    approvalManager: approvals, permissionManager: permissions, secret,
  });
  const port = await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', () => resolve(hookServer.address().port)));
  executors.bridgeEnv = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port), DISCORD_BRIDGE_SECRET: secret };

  const fake = new FakeDiscord({ threadCapable });
  for (const id of channels) if (id !== fake.channelId) fake.addChannel({ id });
  const state = new StateStore(path.join(tmp, `${path.basename(repo)}-${Math.random().toString(36).slice(2)}.json`));
  for (const id of channels) {
    state.patchChannel(id, {
      mode: 'work', cwd: repo, executorId: 'claude', providerId: 'opencode-go', model: MODEL,
    }, repo);
  }
  if (threadCapable) state.patchChannel(fake.channelId, { mode: 'chat' }, repo);

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: repo, claudeCommand: 'claude',
      approvalHost: '127.0.0.1', approvalPort: port, approvalTimeoutMs: 60000,
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1000, stallNoticeMs: 60000,
      allowPaidFallback: false, taskTimeoutMs: 180000,
    },
    state, approvalManager: approvals, permissionManager: permissions,
    providerManager: providers, credentialStore: credentials, executorManager: executors,
    logger: new RunLogger(path.join(tmp, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: MODEL }, allowPaidFallback: false },
    client: fake.client, autoLogin: false,
  });
  await plane.start();
  return { fake, plane, hookServer };
}

async function main() {
  // Use a throwaway credential store: the smoke must never mutate the real one.
  const credentials = new CredentialStore(path.join(tmp, 'credentials.json'));
  const key = readOpenCodeGoKey();
  if (!key) throw new Error('no OpenCode Go credential found (set OPENCODE_GO_API_KEY or log in with the OpenCode CLI)');
  credentials.set('provider:opencode-go', key);
  const providers = new ProviderManager({ file: path.join(tmp, 'providers.json'), credentialStore: credentials });

  const executors = new ExecutorManager({ workbuddyCommand: 'claude', workbuddyEnv: process.env, bridgeEnv: {} });
  await executors.discover();
  for (const executor of executors.list()) console.log(`[executor] ${executor.id}=${executor.status} ${executor.version || ''}`);

  // ---------------------------------------------------------------- Phase 1
  {
    const repo = makeRepo('repo-thread');
    const { fake, plane, hookServer } = await makePlane({ executors, providers, credentials, repo, channels: ['chan-1'], threadCapable: true });
    const startedAt = Date.now();
    await fake.sendAsUser({
      content: 'work Create a file named p1-ok.txt containing exactly P1_WORK_OK, read it back, then reply with only DONE.',
      guildId: 'guild-smoke',
    });
    const thread = fake.threads[0];
    check('W1 work <task> created exactly one Work thread', fake.threads.length === 1);
    check('W2 the parent channel stayed Chat', plane.sessionManager.get(fake.channelId).mode === 'chat');
    check('W3 the thread is a permanent Work thread', Boolean(thread) && plane.state.getChannel(thread.id, repo).workThread === true);
    if (thread) {
      const status = fake.messagesIn(thread.id).map((m) => m.content).join('\n');
      check('W4 the real Agent completed in the thread', /✅ 已完成/.test(status), `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      check('W5 a Work session was bound to the thread', Boolean(plane.state.getChannel(thread.id, repo).sessionId));
    }
    const file = path.join(repo, 'p1-ok.txt');
    check('W6 the real Agent created p1-ok.txt with the expected content',
      fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('P1_WORK_OK'));
    await plane.stopAll({ reason: 'phase 1 done' });
    hookServer.close();
  }

  // ---------------------------------------------------------------- Phase 2
  {
    const repo = makeRepo('repo-queue');
    const { fake, plane, hookServer } = await makePlane({ executors, providers, credentials, repo, channels: ['chan-1', 'chan-2'] });
    const started = [];
    const originalGetRunner = plane.getRunner.bind(plane);
    plane.getRunner = async (channelId) => { started.push(channelId); return originalGetRunner(channelId); };

    const first = fake.sendAsUser({ content: 'work Read README.md and reply with only FIRST.', channelId: 'chan-1' });
    await tick(1500);
    check('Q1 the first real Work task is running', plane.scheduler.stateFor('chan-1').state === 'running');

    const second = fake.sendAsUser({ content: 'work Create p1-second.txt containing SECOND and reply DONE.', channelId: 'chan-2' });
    await tick(800);
    check('Q2 the second task on the same workspace is queued', plane.scheduler.stateFor('chan-2').state === 'queued');
    check('Q3 the queued task created no runner and no task', !plane.runners.has('chan-2') && !plane.tasks.has('chan-2'));
    check('Q4 only the first channel started a real Agent', started.length === 1 && started[0] === 'chan-1', JSON.stringify(started));
    check('Q5 the queued channel got a Workspace busy notice', fake.messagesIn('chan-2').some((m) => /Workspace busy/.test(m.content)));

    await first;
    await tick(1500);
    check('Q6 the queued task started after the first finished', started.includes('chan-2'), JSON.stringify(started));
    await second;
    const secondFile = path.join(repo, 'p1-second.txt');
    check('Q7 the second real Agent ran and wrote its file', fs.existsSync(secondFile) && fs.readFileSync(secondFile, 'utf8').includes('SECOND'));
    await plane.stopAll({ reason: 'phase 2 done' });
    hookServer.close();
  }

  // ---------------------------------------------------------------- Phase 3
  {
    const repo = makeRepo('repo-cancel');
    const { fake, plane, hookServer } = await makePlane({ executors, providers, credentials, repo, channels: ['chan-1', 'chan-2'] });
    const started = [];
    const originalGetRunner = plane.getRunner.bind(plane);
    plane.getRunner = async (channelId) => { started.push(channelId); return originalGetRunner(channelId); };

    const first = fake.sendAsUser({ content: 'work Read README.md and reply with only FIRST.', channelId: 'chan-1' });
    await tick(1500);
    const second = fake.sendAsUser({ content: 'work Create p1-cancel.txt and reply DONE.', channelId: 'chan-2' });
    await tick(800);
    check('C1 the second task is queued', plane.scheduler.stateFor('chan-2').state === 'queued');

    await fake.sendAsUser({ content: '!stop', channelId: 'chan-2' });
    check('C2 queued !stop removed only the queued request', plane.scheduler.stateFor('chan-2').state === 'idle');
    check('C3 the active owner is still running', plane.scheduler.stateFor('chan-1').state === 'running');
    check('C4 the queued request got a cancellation notice', fake.messagesIn('chan-2').some((m) => /已取消排队中/.test(m.content)));

    await fake.sendAsUser({ content: '!stop', channelId: 'chan-1' });
    check('C5 active !stop reports a killed process tree', fake.messagesIn('chan-1').some((m) => /已停止 Agent 进程树/.test(m.content)));
    await first;
    await second;
    await tick(800);
    check('C6 the cancelled queued task never started a real Agent', !started.includes('chan-2'), JSON.stringify(started));
    check('C7 the cancelled task wrote no file', !fs.existsSync(path.join(repo, 'p1-cancel.txt')));
    await plane.stopAll({ reason: 'phase 3 done' });
    hookServer.close();
  }

  clearTimeout(watchdog);
  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== summary: ${results.length - failed.length}/${results.length} passed ===`);
  for (const item of failed) console.log(`FAILED: ${item.name} ${item.detail}`);
  console.log(`artifacts: ${tmp}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[p1-e2e fatal]', error?.stack || error);
  process.exit(1);
});
