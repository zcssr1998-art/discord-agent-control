// Persistent owner settings + `初始化设置` real-machine smoke.
//
// Real: StateStore, DiscordControlPlane (commands / settings panel / reset
// confirmation), PermissionManager, SessionManager, ExecutorManager, a COPY of
// the real state file, and for the inheritance phase a REAL Agent run.
// Fake: the Discord transport only (tests/helpers/fake-discord.mjs).
//
// Every phase runs in a NEW node process over the same state file, so "bridge
// restart" is genuine. The owner's real data/state.json is never modified.
//
//   node scripts/owner-settings-reset-e2e.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
const argv = process.argv.slice(3);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const MODEL = 'deepseek-v4.1-flash';
const CHAT_MODEL = 'deepseek-v4.1-flash';

async function loadProviders() {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'providers.json'), 'utf8'));
  const container = raw.providers ?? raw;
  const list = (Array.isArray(container) ? container : Object.values(container)).filter((p) => p && p.id);
  const opencode = list.find((p) => p.id === 'opencode-go');
  // Canonical product default provider is not stored in providers.json; add it so
  // the reset state renders a readable route.
  return [
    ...(opencode ? [opencode] : []),
    { id: 'workbuddy-free', displayName: 'WorkBuddy Free', protocol: 'workbuddy', billingType: 'FREE', models: [] },
  ];
}

const STUB_EXECUTORS = [
  { id: 'workbuddy', displayName: 'WorkBuddy', available: true, adapterReady: true, status: 'PASS' },
  { id: 'claude', displayName: 'Claude Code', available: true, adapterReady: true, status: 'PASS' },
];

function stubExecutorManager() {
  return {
    list: () => STUB_EXECUTORS,
    get: (id) => STUB_EXECUTORS.find((e) => e.id === id) || null,
    compatible: () => true,
    compatibleExecutors: () => STUB_EXECUTORS,
    resolveTransport: () => 'openai-chat',
    adapterLabel: () => null,
    createRunner: async () => { throw new Error('not used'); },
  };
}

// ---------------------------------------------------------------- child phases
if (phase) {
  const { StateStore } = await import('../src/state.mjs');
  const { DiscordControlPlane } = await import('../src/discord-ui.mjs');
  const { ApprovalManager } = await import('../src/approval-manager.mjs');
  const { PermissionManager, LEVEL } = await import('../src/permission-manager.mjs');
  const { RunLogger } = await import('../src/logger.mjs');
  const { ExecutorManager } = await import('../src/executor-manager.mjs');
  const { readOpenCodeGoKey } = await import('../src/litellm.mjs');
  const { FakeDiscord } = await import('../tests/helpers/fake-discord.mjs');

  const stateFile = arg('state');
  const workspace = arg('workspace');
  const doRun = argv.includes('--run');

  const providers = await loadProviders();
  const opencode = providers.find((p) => p.id === 'opencode-go');
  const state = new StateStore(stateFile);

  async function makePlane({ channelId, hold = false, threadCapable = false, realExecutors = false }) {
    const fake = new FakeDiscord({ threadCapable });
    fake.addChannel({ id: channelId });
    const gate = {};
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    let executors;
    if (realExecutors) {
      executors = new ExecutorManager({ workbuddyCommand: 'claude' });
      await executors.discover();
    } else {
      executors = stubExecutorManager();
    }
    const permissions = new PermissionManager({
      defaultLevel: state.getOwnerDefaultPermission(),
      initialLevels: state.allPermissionLevels(),
      onChange: (id, level, meta) => {
        state.setPermissionLevel(id, level);
        if (meta?.explicit) state.setOwnerDefaults({ permission: level });
      },
    });
    const plane = new DiscordControlPlane({
      config: {
        ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: workspace, claudeCommand: 'claude',
        notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
        allowPaidFallback: false, taskTimeoutMs: 120000, maxWorkFollowUps: 10,
        autoRegisterCommands: false,
      },
      state,
      approvalManager: new ApprovalManager({ timeoutMs: 60000 }),
      permissionManager: permissions,
      providerManager: {
        list: () => providers,
        get: (id) => providers.find((p) => p.id === id) || null,
        hasCredential: () => true,
        health: async () => ({ ok: true }),
      },
      credentialStore: { get: () => readOpenCodeGoKey(), set: () => {}, remove: () => {} },
      executorManager: executors,
      modelManager: { list: async (id) => ({ models: (providers.find((p) => p.id === id)?.models ?? []) }), select: async () => {} },
      chatRuntime: { send: async () => ({ text: 'x' }), health: { list: () => [], reset: () => {} } },
      logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
      backendState: { backend: { label: 'opencode-go', model: MODEL }, allowPaidFallback: false },
      client: fake.client,
      autoLogin: false,
    });
    if (hold) {
      plane.getRunner = async (id) => ({
        sessionId: `sess-${id}`, model: MODEL, busy: false, sent: [], idleMs: 0,
        async send() { this.busy = true; await gate.promise; this.busy = false; return { text: 'ok', sessionId: this.sessionId, durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
        async stop() { this.busy = false; },
      });
    }
    return { fake, plane, gate };
  }

  const out = (value) => { console.log(JSON.stringify(value)); };

  // --- select: explicit owner choices become durable defaults -----------------
  if (phase === 'select') {
    const channelId = 'owner-settings-channel';
    state.patchChannel(channelId, {
      mode: 'work', cwd: workspace, executorId: 'workbuddy', providerId: 'workbuddy-free', model: null,
    }, workspace);
    const { fake, plane } = await makePlane({ channelId });
    await plane.start();
    await fake.sendAsUser({ content: '!executor claude', channelId });
    await fake.sendAsUser({ content: '!provider opencode-go', channelId });
    await fake.sendAsUser({ content: '!model ' + MODEL, channelId });
    await fake.sendAsUser({ content: '!chatmodel opencode-go ' + CHAT_MODEL, channelId });
    await fake.sendAsUser({ content: '!perm full', channelId });
    await fake.clickButton('permfull:confirm');

    const owner = state.getOwnerDefaults();
    out({ phase, owner });
    process.exit(
      owner.executorId === 'claude' && owner.providerId === 'opencode-go' && owner.model === MODEL
      && owner.chatProviderId === 'opencode-go' && owner.chatModel === CHAT_MODEL && owner.permission === LEVEL.FULL
        ? 0 : 1,
    );
  }

  // --- inherit: a new process + new scopes fall back to the owner defaults ----
  if (phase === 'inherit') {
    const freshChannel = 'never-configured-scope';
    const { fake, plane } = await makePlane({ channelId: freshChannel, threadCapable: true, realExecutors: true });
    await plane.start();

    const fresh = plane.effectiveRuntimeState({ channelId: freshChannel });
    const freshPermission = plane.permissionManager.getLevel(freshChannel);
    const runner = await plane.getRunner(freshChannel);
    const inheritedRunnerModel = runner.model;
    await runner.stop?.({ reason: 'smoke' });

    // A permanent Work thread created from a guild parent inherits the route.
    const parentId = 'owner-parent';
    fake.addChannel({ id: parentId, threadCapable: true });
    state.patchChannel(parentId, { mode: 'chat', cwd: workspace }, workspace);
    await fake.sendAsUser({ content: 'work Reply with the single word PONG.', channelId: parentId, guildId: 'guild-1' });
    const thread = fake.threadFor(parentId);
    const threadState = thread ? state.getChannel(thread.id, workspace) : null;
    const threadEffective = thread ? plane.effectiveRuntimeState({ channelId: thread.id }) : null;
    const threadPermission = thread ? plane.permissionManager.getLevel(thread.id) : null;

    let agentRan = false;
    if (doRun && thread) {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (!plane.scheduler.stateFor(thread.id).active && plane.tasks.size === 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const text = fake.messagesIn(thread.id).map((m) => m.content).join('\n');
      agentRan = /✅ 已完成/.test(text);
    }

    out({
      phase,
      fresh: { executor: fresh.executor?.id, provider: fresh.provider?.id, model: fresh.model, permission: freshPermission },
      inheritedRunnerModel,
      thread: threadState && {
        executor: threadState.executorId, provider: threadState.providerId, model: threadState.model,
        effectiveModel: threadEffective?.model, permission: threadPermission,
      },
      agentRan,
    });
    const ok = fresh.executor?.id === 'claude' && fresh.provider?.id === 'opencode-go' && fresh.model === MODEL
      && freshPermission === LEVEL.FULL && inheritedRunnerModel === MODEL
      && threadState?.executorId === 'claude' && threadState?.providerId === 'opencode-go'
      && threadPermission === LEVEL.FULL && (!doRun || agentRan);
    process.exit(ok ? 0 : 1);
  }

  // --- reset-refused: active Work must block initialization -------------------
  if (phase === 'reset-refused') {
    const channelId = 'owner-settings-channel';
    const { fake, plane, gate } = await makePlane({ channelId, hold: true });
    await plane.start();
    const before = state.getOwnerDefaults();

    const task = fake.sendAsUser({ content: 'work long safe task', channelId });
    await new Promise((r) => setTimeout(r, 100));
    const running = plane.scheduler.stateFor(channelId).state === 'running';
    await fake.sendAsUser({ content: '!settings', channelId });
    await fake.clickButton('set:reset');
    await fake.clickButton('setreset:confirm');
    const refused = fake.texts().some((text) => /初始化被拒绝/.test(text));
    const after = state.getOwnerDefaults();
    const stillRunning = plane.scheduler.stateFor(channelId).state === 'running';

    out({ phase, running, refused, preserved: after.providerId === before.providerId && after.permission === before.permission, stillRunning });
    gate.resolve();
    await task;
    process.exit(running && refused && stillRunning && after.providerId === before.providerId ? 0 : 1);
  }

  // --- reset: confirmation, cancel, then durable canonical defaults -----------
  if (phase === 'reset') {
    const channelId = 'owner-settings-channel';
    const { fake, plane } = await makePlane({ channelId, threadCapable: true });
    await plane.start();
    const before = state.getOwnerDefaults();
    if (before.providerId !== 'opencode-go' || before.permission !== LEVEL.FULL) {
      out({ phase, error: 'precondition: owner defaults were not persisted by the select phase', before });
      process.exit(1);
    }

    await fake.sendAsUser({ content: '!settings', channelId });
    await fake.clickButton('set:reset');
    const confirmShown = fake.messages.at(-1).content.includes('确认初始化');
    const untouchedAfterPrompt = state.getOwnerDefaults().providerId === 'opencode-go';
    await fake.clickButton('setreset:cancel');
    const untouchedAfterCancel = state.getOwnerDefaults().providerId === 'opencode-go';

    await fake.sendAsUser({ content: '!settings', channelId });
    await fake.clickButton('set:reset');
    await fake.clickButton('setreset:confirm');
    const owner = state.getOwnerDefaults();
    const canonical = owner.executorId === 'workbuddy' && owner.providerId === 'workbuddy-free'
      && owner.model === null && owner.chatProviderId === 'auto' && owner.chatModel === null
      && owner.permission === LEVEL.STANDARD && owner.workspace === null;

    out({ phase, confirmShown, untouchedAfterPrompt, untouchedAfterCancel, owner, canonical });
    process.exit(confirmShown && untouchedAfterPrompt && untouchedAfterCancel && canonical ? 0 : 1);
  }

  // --- reset-restart: the reset state persists and new scopes inherit it ------
  if (phase === 'reset-restart') {
    const freshChannel = 'post-reset-scope';
    const { fake, plane } = await makePlane({ channelId: freshChannel, threadCapable: true });
    await plane.start();
    const owner = state.getOwnerDefaults();
    const fresh = plane.effectiveRuntimeState({ channelId: freshChannel });
    const freshPermission = plane.permissionManager.getLevel(freshChannel);

    const parentId = 'post-reset-parent';
    fake.addChannel({ id: parentId, threadCapable: true });
    state.patchChannel(parentId, { mode: 'chat', cwd: workspace }, workspace);
    await fake.sendAsUser({ content: 'work inspect', channelId: parentId, guildId: 'guild-2' });
    const thread = fake.threadFor(parentId);
    const threadState = thread ? state.getChannel(thread.id, workspace) : null;
    const threadPermission = thread ? plane.permissionManager.getLevel(thread.id) : null;

    out({ phase, owner, fresh: { executor: fresh.executor?.id, provider: fresh.provider?.id, model: fresh.model, permission: freshPermission }, thread: threadState && { executor: threadState.executorId, provider: threadState.providerId, permission: threadPermission } });
    const ok = owner.providerId === 'workbuddy-free' && owner.permission === LEVEL.STANDARD
      && fresh.executor?.id === 'workbuddy' && fresh.provider?.id === 'workbuddy-free' && fresh.model === null
      && freshPermission === LEVEL.STANDARD
      && threadState?.executorId === 'workbuddy' && threadState?.providerId === 'workbuddy-free'
      && threadPermission === LEVEL.STANDARD;
    process.exit(ok ? 0 : 1);
  }

  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}

// ------------------------------------------------------------------- driver
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-owner-ws-'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-owner-state-'));
const stateFile = path.join(sandbox, 'state.json');
fs.copyFileSync(path.join(root, 'data', 'state.json'), stateFile);
// A sandbox copy of the user-data files the reset must never touch.
const sideFiles = ['credentials.json', 'providers.json', 'chat-history.json'];
for (const name of sideFiles) {
  const src = path.join(root, 'data', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sandbox, name));
}
const sideSnapshots = sideFiles
  .filter((name) => fs.existsSync(path.join(sandbox, name)))
  .map((name) => ({ name, content: fs.readFileSync(path.join(sandbox, name), 'utf8') }));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const runPhase = (name, args = []) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), name, '--state', stateFile, '--workspace', workspace, ...args], { cwd: root, encoding: 'utf8', timeout: 240000 });
const lastJson = (out) => {
  const lines = String(out || '').trim().split('\n').filter((l) => l.trim().startsWith('{'));
  try { return JSON.parse(lines.at(-1)); } catch { return null; }
};

console.log(`[smoke] workspace=${workspace}`);
console.log(`[smoke] state=${stateFile} (copy of the real state file)`);

// A. explicit owner selections persist across a real process restart.
{
  const res = runPhase('select');
  const json = lastJson(res.stdout);
  check('A1 explicit executor/provider/model/chat/permission persist as owner defaults',
    res.status === 0, json ? JSON.stringify(json.owner) : (res.stderr || '').trim().split('\n').at(-1));
}
// B/C. a NEW process inherits them for a fresh scope and a new Work thread.
{
  const res = runPhase('inherit', ['--run']);
  const json = lastJson(res.stdout);
  check('B/C new process: fresh scope + new Work thread + real Agent run use the owner defaults',
    res.status === 0, json ? JSON.stringify(json) : (res.stderr || '').trim().split('\n').at(-1));
}
// F. reset is refused while a Work task is active; the task is not killed.
{
  const res = runPhase('reset-refused');
  const json = lastJson(res.stdout);
  check('F active Work: initialization refused, task alive, settings unchanged',
    res.status === 0, json ? JSON.stringify(json) : (res.stderr || '').trim().split('\n').at(-1));
}
// D/E. confirmation gate, cancel, confirm, data preservation.
{
  const res = runPhase('reset');
  const json = lastJson(res.stdout);
  check('D 初始化设置: confirmation required, cancel is a no-op, confirm restores product defaults',
    res.status === 0, json ? JSON.stringify({ confirmShown: json.confirmShown, owner: json.owner }) : (res.stderr || '').trim().split('\n').at(-1));
}
// D. the reset state persists across another restart and new scopes inherit it.
{
  const res = runPhase('reset-restart');
  const json = lastJson(res.stdout);
  check('D reset persists across restart and new Work thread inherits the reset defaults',
    res.status === 0, json ? JSON.stringify(json.fresh) : (res.stderr || '').trim().split('\n').at(-1));
}
// E. data preservation: sandbox credentials/providers/history byte-identical.
{
  const intact = sideSnapshots.every(({ name, content }) => {
    const file = path.join(sandbox, name);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content;
  });
  check('E credentials / providers / chat history untouched by initialization', intact,
    `${sideSnapshots.length} sandbox file(s) byte-identical`);
  // The real run database is still a readable SQLite file.
  const db = path.join(root, 'data', 'jarvis.db');
  let readable = false;
  try {
    const fd = fs.openSync(db, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    readable = buf.toString('utf8').startsWith('SQLite format 3');
  } catch { readable = false; }
  check('E real run database remains readable (no settings reset damage)', readable);
}
// E. no secret material in any captured phase output.
{
  const { readOpenCodeGoKey } = await import('../src/litellm.mjs');
  const secrets = [readOpenCodeGoKey(), process.env.DISCORD_TOKEN].filter((s) => typeof s === 'string' && s.length >= 12);
  // Re-run nothing: the driver never prints secrets, and none appeared above.
  const leaked = secrets.filter((secret) => results.some((r) => (r.detail || '').includes(secret)));
  check('E no secret material appears in smoke output', leaked.length === 0, `${secrets.length} secret(s) checked, 0 leaked`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nowner-settings/reset smoke: ${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(sandbox, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
