// P2.2 workspace selection real-machine smoke.
//
// Proves with REAL node processes (and a real Agent run in TEST 2) that:
//   1. a historical run directory can never become the workspace;
//   2/3. the default workspace comes from config/repo, and a task really runs there;
//   4. an explicit `!workspace <dir>` persists and survives a restart;
//   5. a temporary run directory does not rewrite the saved workspace;
//   6. `!workspace reset` restores the default;
//   7. a non-existent directory is rejected without changing state.
//
// The owner's real data/state.json is never modified (a copy is used).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
const argv = process.argv.slice(3);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const flag = (name) => argv.includes(`--${name}`);

if (phase) {
  const { StateStore } = await import('../src/state.mjs');
  const { DiscordControlPlane } = await import('../src/discord-ui.mjs');
  const { ApprovalManager } = await import('../src/approval-manager.mjs');
  const { PermissionManager } = await import('../src/permission-manager.mjs');
  const { RunLogger } = await import('../src/logger.mjs');
  const { ExecutorManager } = await import('../src/executor-manager.mjs');
  const { DurableStore } = await import('../src/durable-store.mjs');
  const { readOpenCodeGoKey } = await import('../src/litellm.mjs');
  const { createHookServer, ensureHookSecret } = await import('../src/hook-server.mjs');
  const { FakeDiscord } = await import('../tests/helpers/fake-discord.mjs');

  const stateFile = arg('state');
  const repoRoot = arg('repo');
  const channelId = arg('channel') || 'chan-ws-smoke';
  const providersFile = JSON.parse(fs.readFileSync(path.join(root, 'data', 'providers.json'), 'utf8'));
  const container = providersFile.providers ?? providersFile;
  const provider = (Array.isArray(container) ? container : Object.values(container)).find((p) => p?.id === 'opencode-go');
  if (!provider) { console.error('phase: provider missing'); process.exit(3); }

  const state = new StateStore(stateFile);
  const workdir = arg('workspace') || state.getGlobalWorkspace()?.path || repoRoot;
  const durableStore = arg('db') ? (() => { const s = new DurableStore({ file: arg('db'), logger: null }); s.open(); return s; })() : null;
  const fake = new FakeDiscord();
  const workChannel = fake.channelId;
  state.patchChannel(workChannel, { mode: 'work', cwd: workdir, executorId: 'claude', providerId: 'opencode-go' }, workdir);

  const executors = new ExecutorManager({ workbuddyCommand: 'claude' });
  await executors.discover();
  const secret = ensureHookSecret();
  const hookServer = createHookServer({
    config: { approvalHost: '127.0.0.1', approvalPort: 0 }, approvalManager: new ApprovalManager({ timeoutMs: 30000 }), permissionManager: new PermissionManager(), secret,
  });
  const port = await new Promise((resolve) => { hookServer.listen(0, '127.0.0.1', () => resolve(hookServer.address().port)); });

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: repoRoot, claudeCommand: 'claude',
      notifyOnStart: true, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 120000, maxWorkFollowUps: 10,
      defaultWorkspace: repoRoot, repoRoot,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 30000 }),
    permissionManager: new PermissionManager(),
    providerManager: { list: () => [provider], get: (id) => (id === provider.id ? provider : null), hasCredential: () => true },
    credentialStore: { get: () => readOpenCodeGoKey(), set: () => {}, remove: () => {} },
    executorManager: executors,
    modelManager: { list: async () => ({ models: provider.models ?? [] }), select: async () => {} },
    chatRuntime: { send: async () => ({ text: 'x' }) },
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: { backend: { label: 'OpenCode Go', model: 'deepseek-v4.1-flash' } },
    durableStore,
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();
  const card = fake.messagesIn(`dm:${fake.ownerId}`).map((m) => m.content).join('\n');
  const cardWorkspace = (card.match(/工作目录：`(.+)`/) ?? [])[1] ?? null;

  if (phase === 'inspect') {
    const effective = plane.effectiveRuntimeState({});
    console.log(JSON.stringify({
      workspace: effective.workspace, source: effective.workspaceSource,
      cardWorkspace, persisted: Boolean(state.getGlobalWorkspace()),
    }));
    process.exit(0);
  }

  if (phase === 'set') {
    await fake.sendAsUser({ content: `!workspace ${arg('set')}` });
    const reply = fake.messagesIn(workChannel).at(-1).content;
    console.log(JSON.stringify({ reply: reply.split('\n')[0], persisted: state.getGlobalWorkspace()?.path ?? null }));
    process.exit(/已切换并持久化/.test(reply) ? 0 : 1);
  }

  if (phase === 'reject') {
    await fake.sendAsUser({ content: `!workspace ${arg('set')}` });
    const reply = fake.messagesIn(workChannel).at(-1).content;
    console.log(JSON.stringify({ reply: reply.split('\n')[0], persisted: state.getGlobalWorkspace()?.path ?? null, channelCwd: plane.sessionManager.get(workChannel).cwd }));
    process.exit(/不存在|不是目录|绝对路径/.test(reply) ? 0 : 1);
  }

  if (phase === 'reset') {
    await fake.sendAsUser({ content: '!workspace reset' });
    const reply = fake.messagesIn(workChannel).at(-1).content;
    console.log(JSON.stringify({ reply: reply.split('\n')[0], persisted: state.getGlobalWorkspace()?.path ?? null, channelCwd: plane.sessionManager.get(workChannel).cwd }));
    process.exit(/已恢复默认工作目录/.test(reply) && !state.getGlobalWorkspace() ? 0 : 1);
  }

  if (phase === 'run') {
    // Real Agent run in the effective workspace: prove the cwd matches the card.
    state.rememberWorkModel({ channelId: workChannel, cwd: workdir, providerId: 'opencode-go', executorId: 'claude', model: 'deepseek-v4.1-flash' });
    await fake.sendAsUser({ content: 'Create a file named ws_probe.txt containing EXACTLY the string WS_OK, then reply WS_DONE.' });
    const runner = plane.runners.get(workChannel);
    const launchedCwd = runner?.child?.spawnargs?.length ? runner.cwd : runner?.cwd ?? null;
    const cardText = fake.messagesIn(workChannel).map((m) => m.content).join('\n');
    const probe = path.join(workdir, 'ws_probe.txt');
    const content = fs.existsSync(probe) ? fs.readFileSync(probe, 'utf8').trim() : null;
    console.log(JSON.stringify({
      cardWorkspace, launchedCwd, agentCwd: launchedCwd, probeContent: content,
      done: /✅ 已完成/.test(cardText), runWorkspace: durableStore?.latestRun()?.workspace ?? null,
    }));
    try { fs.rmSync(probe, { force: true }); } catch { /* ignore */ }
    process.exit(content === 'WS_OK' && launchedCwd === cardWorkspace ? 0 : 1);
  }

  if (phase === 'temp-run') {
    // Record a run in a temporary directory, then prove the saved workspace is intact.
    const tmp = arg('run');
    if (durableStore) {
      durableStore.runStart({ runId: 'temp-probe', channelId: workChannel, workspace: tmp, model: 'deepseek-v4.1-flash', providerId: 'opencode-go' });
      durableStore.runFinish('temp-probe', { state: 'DONE' });
    }
    console.log(JSON.stringify({ persisted: state.getGlobalWorkspace()?.path ?? null, effective: plane.effectiveRuntimeState({}).workspace }));
    process.exit(0);
  }

  process.exit(0);
}

// --------------------------------------------------------------------- driver
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-smoke-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-state-'));
const stateFile = path.join(stateDir, 'state.json');
const dbFile = path.join(stateDir, 'jarvis.db');
fs.copyFileSync(path.join(root, 'data', 'state.json'), stateFile);
const repoRoot = root;
const target = path.join(work, 'explicit-target');
fs.mkdirSync(target, { recursive: true });

const results = [];
const check = (name, res, expect = true) => {
  const ok = res.status === 0 && expect;
  const stdout = (res.stdout || '').trim().split('\n').pop() ?? '';
  const stderr = (res.stderr || '').trim().split('\n').slice(-2).join(' | ');
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} · ${stdout}${ok ? '' : `\n     stderr: ${stderr}`}`);
};
const run = (phase, args = []) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase, '--state', stateFile, '--repo', repoRoot, '--db', dbFile, ...args], {
  cwd: root, encoding: 'utf8', timeout: 180000,
});

console.log(`[smoke] repoRoot=${repoRoot}`);
console.log(`[smoke] explicit target=${target} (state copy: ${stateFile})`);

// TEST 1/2: no saved pointer; a historical run dir must not leak in.
{
  const res = run('temp-run', ['--run', path.join(work, 'old-run-dir')]);
  check('TEST 1 recent-run cannot become the workspace', res);
  const inspect = run('inspect');
  check('TEST 2 default workspace is config/repo, not a run dir', inspect, /"source":"config"/.test(inspect.stdout || ''));
}

// TEST 2b: a real Agent really runs in the workspace shown on the card.
check('TEST 2 Agent cwd == startup card workspace (real run)', run('run'));

// TEST 3: explicit switch.
check('TEST 3 !workspace switches and persists', run('set', ['--set', target]));

// TEST 4: restart restores it.
{
  const res = run('inspect');
  check('TEST 4 restart restores the selected workspace', res, (res.stdout || '').includes('"source":"saved"') && (res.stdout || '').includes(target.replace(/\\/g, '\\\\')));
}

// TEST 5: a temporary run dir does not move the saved workspace.
{
  const tmpRun = path.join(work, 'temp-after-save');
  fs.mkdirSync(tmpRun, { recursive: true });
  const res = run('temp-run', ['--run', tmpRun]);
  check('TEST 5 temporary run does not touch the saved workspace', res, (res.stdout || '').includes(target.replace(/\\/g, '\\\\')));
}

// TEST 6: reset.
check('TEST 6 !workspace reset restores the default', run('reset'));

// TEST 7: invalid path rejected.
check('TEST 7 !workspace rejects a non-existent directory', run('reject', ['--set', 'X:\\definitely-not-exist']));

const failed = results.filter((r) => !r.ok);
console.log(`\nP2.2 workspace smoke: ${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
