#!/usr/bin/env node
/**
 * P2.2.3 K4/K5 real-machine E2E.
 *
 * Real: OpenCode Go credential + Claude Code CLI (through the local
 * Anthropic->OpenAI adapter), the real PreToolUse hook server, the real
 * PermissionManager, ProviderManager/ExecutorManager, the real
 * DiscordControlPlane and the filesystem.
 * Fake: only the Discord transport.
 *
 * Proves on the real machine:
 *   K4.1 FULL parent -> Work thread inherits FULL and shows 全开放;
 *   K4.2 a representative multi-step repo task runs with ZERO approval prompts;
 *   K4.3 the hard secret guard is still active (git add .env is denied locally
 *        without bothering the owner);
 *   K5.1 no wall-clock kill under the production default (taskTimeoutMs=0);
 *   K5.2 owner `!stop` still terminates the real process tree.
 *
 * It never reboots, never touches the owner's real state (temp state only) and
 * never prints secrets.
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
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { readOpenCodeGoKey } from '../src/litellm.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const MODEL = process.env.P223_MODEL || 'deepseek-v4.1-flash';
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const watchdog = setTimeout(() => { console.error('HARD_TIMEOUT'); process.exit(2); }, 420000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p223-full-'));

function makeRepo() {
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'smoke@local'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'P223 Smoke'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# p223 full-permission smoke\n');
  fs.writeFileSync(path.join(dir, 'src.txt'), 'ALPHA\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'chore: init'], { cwd: dir });
  return dir;
}

async function main() {
  const repo = makeRepo();
  const credentials = new CredentialStore(path.join(tmp, 'credentials.json'));
  const key = readOpenCodeGoKey();
  if (!key) throw new Error('no OpenCode Go credential found');
  credentials.set('provider:opencode-go', key);
  const providers = new ProviderManager({ file: path.join(tmp, 'providers.json'), credentialStore: credentials });

  const fake = new FakeDiscord({ threadCapable: true });
  const state = new StateStore(path.join(tmp, 'state.json'));
  state.patchChannel(fake.channelId, {
    mode: 'chat', cwd: repo, executorId: 'claude', providerId: 'opencode-go', model: MODEL,
  }, repo);

  const executors = new ExecutorManager({ workbuddyCommand: 'claude', workbuddyEnv: process.env, bridgeEnv: {} });
  await executors.discover();
  const claude = executors.get('claude');
  check('the Claude Code executor is available', Boolean(claude?.available), `${claude?.status} ${claude?.version || ''}`);

  const secret = ensureHookSecret();
  const permissions = new PermissionManager();
  let prompts = 0;
  const approvals = new ApprovalManager({ timeoutMs: 120000 });
  approvals.setPresenter((req) => {
    prompts += 1;
    console.log(`[e2e] UNEXPECTED approval request: tool=${req.toolName} reason=${req.reason}`);
    approvals.resolve(req.id, 'deny');
  });
  const hookServer = createHookServer({
    config: { defaultCwd: repo, autoAllowWorkspaceWrites: true, autoAllowTestCommands: true },
    approvalManager: approvals, permissionManager: permissions, secret,
  });
  const port = await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', () => resolve(hookServer.address().port)));
  executors.bridgeEnv = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port), DISCORD_BRIDGE_SECRET: secret };

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: repo, claudeCommand: 'claude',
      approvalHost: '127.0.0.1', approvalPort: port, approvalTimeoutMs: 120000,
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1000, stallNoticeMs: 60000,
      allowPaidFallback: false, taskTimeoutMs: 0,
    },
    state, approvalManager: approvals, permissionManager: permissions,
    providerManager: providers, credentialStore: credentials, executorManager: executors,
    logger: new RunLogger(path.join(repo, 'logs')),
    backendState: { backend: { label: 'opencode-go', model: MODEL }, allowPaidFallback: false },
    client: fake.client, autoLogin: false,
  });
  await plane.start();

  // K4.1: owner confirms FULL once, then starts a Work thread.
  permissions.confirmFull(fake.channelId);
  check('K4.1 parent is FULL', permissions.getLevel(fake.channelId) === LEVEL.FULL);

  await fake.sendAsUser({
    content: 'work Read README.md and src.txt, then create full-ok.txt containing exactly FULL_OK, then reply with only DONE.',
    guildId: 'guild-smoke',
  });
  const thread = fake.threads[0];
  check('K4.1 a Work thread was created', Boolean(thread) && fake.threads.length === 1);
  check('K4.1 the Work thread inherited FULL (not STANDARD)', permissions.getLevel(thread?.id) === LEVEL.FULL);

  // Wait for the real Agent to finish.
  const outFile = path.join(repo, 'full-ok.txt');
  for (let i = 0; i < 120 && !fs.existsSync(outFile); i += 1) await tick(1000);
  const threadText = fake.messagesIn(thread.id).map((m) => m.content).join('\n');

  check('K4.1 the progress card reports 全开放', /全开放/.test(threadText));
  check('K4.2 a real multi-step task completed', /✅ 已完成/.test(threadText), `taskDone=${/✅ 已完成/.test(threadText)}`);
  check('K4.2 the real Agent produced the file', fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').includes('FULL_OK'));
  check('K4.2 zero routine approval prompts under FULL', prompts === 0, `prompts=${prompts}`);
  check('K5.1 no wall-clock timeout under the production default', !/执行超时|达到时间上限/.test(threadText));

  // K4.3: the hard secret guard is independent of FULL and still applies. Bind a
  // session to the FULL thread explicitly so the gate classifies as FULL.
  permissions.syncSession('k4-hard-guard-session', thread.id);
  const secretDecision = await (async () => {
    const r = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add .env' }, cwd: repo, session_id: 'k4-hard-guard-session' }),
    });
    return (await r.json()).hookSpecificOutput.permissionDecision;
  })();
  check('K4.3 the secret-commit hard guard still denies under FULL', secretDecision === 'deny', `decision=${secretDecision}`);
  check('K4.3 the hard guard never became an approval prompt', prompts === 0);

  // K5.2: a real long-running task can be stopped by the owner. Do NOT await the
  // send: the task keeps running while we press Stop.
  const threadsBefore = fake.threads.length;
  const sending = fake.sendAsUser({
    content: 'work Run this exact PowerShell command and wait for it: Start-Sleep -Seconds 45 ; then reply DONE.',
    guildId: 'guild-smoke',
  });
  for (let i = 0; i < 60 && fake.threads.length <= threadsBefore; i += 1) await tick(500);
  const stopThread = fake.threads.at(-1);
  check('K5.2 a Work thread exists for the long task', fake.threads.length > threadsBefore);
  for (let i = 0; i < 60 && !plane.tasks.has(stopThread?.id); i += 1) await tick(500);
  check('K5.2 a real long-running task is active before Stop', plane.tasks.has(stopThread?.id));
  await fake.sendAsUser({ content: '!stop', channelId: stopThread.id, guildId: 'guild-smoke' });
  await sending.catch(() => {});
  await tick(1000);
  check('K5.2 owner Stop released the task', !plane.tasks.has(stopThread.id));
  check('K5.2 the runner really stopped', Boolean(plane.runners.get(stopThread.id)?.stopped || !plane.runners.has(stopThread.id)));

  await plane.stopAll({ reason: 'e2e done' });
  hookServer.close();

  clearTimeout(watchdog);
  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== summary: ${results.length - failed.length}/${results.length} passed ===`);
  for (const item of failed) console.log(`FAILED: ${item.name} ${item.detail}`);
  console.log(`artifacts: ${tmp}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  clearTimeout(watchdog);
  console.error('[p223-full-e2e fatal]', error?.stack || error);
  process.exit(1);
});
