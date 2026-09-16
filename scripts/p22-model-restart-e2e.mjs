// P2.2 selected-model persistence: real-machine restart smoke.
//
// Runs the REAL control plane over a COPY of the real state file in separate
// node processes, so "bridge restart" / "new process" is genuine:
//   phase select   → owner runs `!model <id>` in a real channel
//   phase resolve  → a NEW process (no !model) restores the model and launches a
//                    real Agent with it
//   phase invalid  → a bogus saved model produces the explicit unavailable error
//
// The owner's real data/state.json is never modified.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
const argv = process.argv.slice(3);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

// ---------------------------------------------------------------- child phases
if (phase === 'select' || phase === 'resolve' || phase === 'invalid') {
  const { StateStore } = await import('../src/state.mjs');
  const { DiscordControlPlane } = await import('../src/discord-ui.mjs');
  const { ApprovalManager } = await import('../src/approval-manager.mjs');
  const { PermissionManager } = await import('../src/permission-manager.mjs');
  const { RunLogger } = await import('../src/logger.mjs');
  const { ExecutorManager } = await import('../src/executor-manager.mjs');
  const { readOpenCodeGoKey } = await import('../src/litellm.mjs');
  const { FakeDiscord } = await import('../tests/helpers/fake-discord.mjs');

  const stateFile = arg('state');
  const workspace = arg('workspace');
  const channelId = arg('channel') || 'chan-model-smoke';
  const model = arg('model');
  const doRun = argv.includes('--run');

  const providersFile = JSON.parse(fs.readFileSync(path.join(root, 'data', 'providers.json'), 'utf8'));
  // providers.json is { providers: { <id>: {...} } } (or a plain list).
  const container = providersFile.providers ?? providersFile;
  const list = Array.isArray(container) ? container : Object.values(container);
  const provider = list.find((p) => p && p.id === 'opencode-go');
  if (!provider) { console.error('phase: opencode-go provider missing'); process.exit(3); }

  const state = new StateStore(stateFile);
  const fake = new FakeDiscord({ threadCapable: true });
  fake.addChannel({ id: channelId });
  state.patchChannel(channelId, {
    mode: 'work', cwd: workspace, executorId: 'claude', providerId: 'opencode-go', model: null,
  }, workspace);

  const executors = new ExecutorManager({ workbuddyCommand: 'claude' });
  await executors.discover();

  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: workspace, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 600000,
      allowPaidFallback: false, taskTimeoutMs: 120000, maxWorkFollowUps: 10,
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
    backendState: { backend: { label: 'OpenCode Go', model }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();

  if (phase === 'select') {
    await fake.sendAsUser({ content: `!model ${model}`, channelId });
    const savedChannel = state.getChannel(channelId, workspace).model;
    const savedWorkspace = state.getWorkspaceModel(workspace);
    const savedLast = state.getLastWorkModel();
    console.log(JSON.stringify({
      phase, channel: savedChannel, workspace: savedWorkspace?.model ?? null, last: savedLast?.model ?? null,
    }));
    process.exit(savedChannel === model && savedWorkspace?.model === model ? 0 : 1);
  }

  if (phase === 'invalid') {
    try {
      await plane.getRunner(channelId);
      console.log(JSON.stringify({ phase, resolved: true }));
      process.exit(1);
    } catch (error) {
      console.log(JSON.stringify({ phase, code: error.code, message: error.message }));
      process.exit(error.code === 'MODEL_UNAVAILABLE' ? 0 : 1);
    }
  }

  // phase === 'resolve': restore without any !model, then optionally run for real.
  let runner;
  try {
    runner = await plane.getRunner(channelId);
  } catch (error) {
    console.log(JSON.stringify({ phase, restored: false, code: error.code, message: error.message }));
    process.exit(1);
  }

  if (!doRun) {
    console.log(JSON.stringify({ phase, restored: true, model: runner.model, channelModel: state.getChannel(channelId, workspace).model }));
    await runner.stop?.({ reason: 'smoke' });
    process.exit(runner.model ? 0 : 1);
  }

  const cardText = await new Promise(async (resolve) => {
    await fake.sendAsUser({ content: 'Reply with the single word PONG.', channelId });
    resolve(fake.messagesIn(channelId).map((m) => m.content).join('\n'));
  });
  const done = /✅ 已完成/.test(cardText);
  console.log(JSON.stringify({ phase, restored: true, model: runner.model, agentRan: done }));
  process.exit(runner.model && done ? 0 : 1);
}

// ------------------------------------------------------------------- driver
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-ws-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-state-'));
const stateFile = path.join(stateDir, 'state.json');
// Start from the REAL state file so the upgrade/backfill path is exercised too.
fs.copyFileSync(path.join(root, 'data', 'state.json'), stateFile);

const results = [];
const check = (name, res) => {
  const ok = res.status === 0;
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim().split('\n').slice(-3).join(' | ');
  results.push({ name, ok, stdout });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} · ${stdout}${ok ? '' : `\n     stderr: ${stderr}`}`);
  return ok;
};
const runPhase = (phase, args) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase, ...args], {
  cwd: root, encoding: 'utf8', timeout: 180000,
});

const MODEL_A = 'deepseek-v4.1-flash';
const MODEL_B = 'glm-5.3-flash';

console.log(`[smoke] workspace=${workspace}`);
console.log(`[smoke] state=${stateFile} (copy of the real state file)`);

// TEST 1: select a model.
check('TEST 1 select model persists', runPhase('select', ['--state', stateFile, '--workspace', workspace, '--model', MODEL_A]));

// TEST 2/3: a NEW process restores it and launches the Agent — no !model.
check('TEST 2/3 new process restores model and starts a normal task',
  runPhase('resolve', ['--state', stateFile, '--workspace', workspace, '--run']));

// TEST 4: switch to another model, restart, the NEW model is restored.
check('TEST 4 switch persists', runPhase('select', ['--state', stateFile, '--workspace', workspace, '--model', MODEL_B]));
const switched = runPhase('resolve', ['--state', stateFile, '--workspace', workspace]);
check('TEST 4 restart restores the NEW model', switched);
if (switched.status === 0 && !switched.stdout.includes(MODEL_B)) {
  console.log(`FAIL TEST 4 restored model mismatch (expected ${MODEL_B}): ${switched.stdout}`);
  results.push({ name: 'TEST 4 restored model matches', ok: false, stdout: switched.stdout });
}

// TEST 5: a bogus saved model must fail loudly, not crash or silently switch.
{
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw.preferences = raw.preferences ?? {};
  raw.preferences.lastWorkModel = { providerId: 'opencode-go', executorId: 'claude', model: 'model-that-does-not-exist' };
  for (const key of Object.keys(raw.workspaces ?? {})) raw.workspaces[key].model = 'model-that-does-not-exist';
  const channel = raw.channels['chan-model-smoke'];
  if (channel) channel.model = null;
  fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2));
  check('TEST 5 unavailable saved model fails explicitly', runPhase('invalid', ['--state', stateFile, '--workspace', workspace]));
}

const failed = results.filter((r) => !r.ok);
console.log(`\nP2.2 model-restart smoke: ${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
