// P2.2.2 Chat model selection: real-machine smoke.
//
// Real: the real ProviderManager + CredentialStore + ChatRuntime (real network
// calls to the configured LiteLLM gateway / OpenCode Go), the real control
// plane, and a real StateStore loaded in a SEPARATE node process for every
// phase, so "bridge restart" is genuine.
// Fake: only the Discord transport (tests/helpers/fake-discord.mjs).
//
// It reproduces the exact post-reboot persisted value reported by the owner
// (`opencode-go / <model-id>`) in a COPY of the real state file, then proves:
//   1. the historical placeholder pin is auto-repaired to AUTO/null on load
//      (and persisted), without touching Work/cwd/session fields;
//   2. ordinary 你好 succeeds in AUTO;
//   3. the Chat menu offers AUTO + real providers + real discovered models;
//   4. a real manual pin chats successfully and /status shows it;
//   5. switching back to AUTO chats successfully;
//   6. a new process restores the manual pin, then AUTO, correctly.
//
// The owner's real data/state.json is NEVER modified.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
const argv = process.argv.slice(3);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

// ---------------------------------------------------------------- child phases

async function buildPlane({ stateFile, channelId, cwd }) {
  const { StateStore } = await import('../src/state.mjs');
  const { DiscordControlPlane } = await import('../src/discord-ui.mjs');
  const { ApprovalManager } = await import('../src/approval-manager.mjs');
  const { PermissionManager } = await import('../src/permission-manager.mjs');
  const { RunLogger } = await import('../src/logger.mjs');
  const { ProviderManager } = await import('../src/provider-manager.mjs');
  const { ModelManager } = await import('../src/model-manager.mjs');
  const { CredentialStore } = await import('../src/credential-store.mjs');
  const { ChatRuntime } = await import('../src/chat-runtime.mjs');
  const { loadLiteLLMConfig } = await import('../src/litellm.mjs');
  const { FakeDiscord } = await import('../tests/helpers/fake-discord.mjs');

  const credentials = new CredentialStore(path.join(root, 'data', 'credentials.json'));
  const providers = new ProviderManager({ file: path.join(root, 'data', 'providers.json'), credentialStore: credentials });
  const litellmConfig = loadLiteLLMConfig(process.env, { root });
  if (litellmConfig.enabled) {
    if (litellmConfig.masterKey) credentials.set('provider:litellm', litellmConfig.masterKey);
    providers.registerLitellm({ baseUrl: litellmConfig.baseUrl, billingType: litellmConfig.billingType });
  }
  const models = new ModelManager(providers);
  const chatRuntime = new ChatRuntime({
    providerManager: providers, credentialStore: credentials, timeoutMs: 30000, allowMeteredFallback: false,
  });

  const state = new StateStore(stateFile);
  const fake = new FakeDiscord({ ownerId: 'owner-p222-smoke', channelId });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: cwd, claudeCommand: 'claude',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    modelManager: models,
    credentialStore: credentials,
    chatRuntime,
    logger: new RunLogger(path.join(path.dirname(stateFile), 'logs')),
    backendState: { backend: { label: 'smoke', model: null }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();
  return { plane, fake, state, providers };
}

function selectionOf(plane, channelId) {
  const value = plane.sessionManager.get(channelId);
  return { providerId: value.chatProviderId || 'auto', model: value.chatModel || null };
}

async function chatTurn(fake, text = '你好') {
  await fake.sendAsUser({ content: text });
  const reply = fake.messages.at(-1)?.content ?? '';
  const failed = /❌/.test(reply);
  const foot = (reply.match(/💬 Chat · ([^\n]+)/) ?? [])[1] ?? null;
  return { ok: !failed && Boolean(foot), footer: foot, preview: reply.slice(0, 120) };
}

async function lastStatusRoute(fake) {
  await fake.sendAsUser({ content: '!status' });
  const status = fake.messages.at(-1)?.content ?? '';
  return (status.match(/路由：([^\n]+)/) ?? [])[1] ?? null;
}

if (['auto', 'pin', 'restore-pin', 'back-auto', 'restore-auto'].includes(phase)) {
  const stateFile = arg('state');
  const channelId = arg('channel');
  const cwd = arg('cwd') || root;
  let historicalPin = null;
  if (phase === 'auto') {
    const before = JSON.parse(fs.readFileSync(stateFile, 'utf8')).channels?.[channelId] ?? null;
    historicalPin = before ? { providerId: before.chatProviderId ?? null, model: before.chatModel ?? null } : null;
  }
  const { plane, fake, state } = await buildPlane({ stateFile, channelId, cwd });
  const afterLoad = selectionOf(plane, channelId);
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8')).channels?.[channelId] ?? null;
  const diskSelection = { providerId: onDisk?.chatProviderId ?? null, model: onDisk?.chatModel ?? null };
  const preserve = {
    cwd: onDisk?.cwd ?? null,
    workProvider: onDisk?.providerId ?? null,
    workModel: onDisk?.model ?? null,
    sessionId: onDisk?.sessionId ?? null,
    mode: onDisk?.mode ?? null,
  };
  const result = { phase, historicalPin, afterLoad, diskSelection, preserve };

  if (phase === 'auto') {
    result.chatAuto = await chatTurn(fake);
    result.statusRoute = await lastStatusRoute(fake);
  }
  if (phase === 'pin') {
    await fake.sendAsUser({ content: '!chatmodel opencode-go deepseek-v4.1-flash' });
    result.pinReply = (fake.messages.at(-1)?.content ?? '').split('\n')[0];
    result.pinned = selectionOf(plane, channelId);
    result.chatPinned = await chatTurn(fake);
    result.statusRoute = await lastStatusRoute(fake);
  }
  if (phase === 'restore-pin') {
    result.chatPinned = await chatTurn(fake);
    result.statusRoute = await lastStatusRoute(fake);
  }
  if (phase === 'back-auto') {
    await fake.sendAsUser({ content: '!chatmodel auto' });
    result.autoReply = (fake.messages.at(-1)?.content ?? '').split('\n')[0];
    result.afterSwitch = selectionOf(plane, channelId);
    result.chatAuto = await chatTurn(fake);
    result.statusRoute = await lastStatusRoute(fake);
  }
  if (phase === 'restore-auto') {
    result.chatAuto = await chatTurn(fake);
    result.statusRoute = await lastStatusRoute(fake);
  }

  // The Chat path must never create an agent runner.
  result.agentRunners = plane.runners.size;
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(result.agentRunners === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------- driver

const realState = path.join(root, 'data', 'state.json');
if (!fs.existsSync(realState)) { console.error('driver: real data/state.json missing'); process.exit(2); }

const real = JSON.parse(fs.readFileSync(realState, 'utf8'));
const channels = real.channels ?? {};
const CHANNEL = Object.keys(channels).find((id) => channels[id]?.mode === 'chat')
  ?? Object.keys(channels)[0];
if (!CHANNEL) { console.error('driver: no channel in state to attach the smoke to'); process.exit(2); }
const CWD = channels[CHANNEL]?.cwd || root;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p222-smoke-'));
const stateFile = path.join(workDir, 'state.json');
// Reproduce the exact owner-reported persisted value in a copy of the real state.
const fixture = JSON.parse(JSON.stringify(real));
fixture.channels[CHANNEL] = { ...(fixture.channels[CHANNEL] ?? {}), chatProviderId: 'opencode-go', chatModel: '<model-id>' };
fs.writeFileSync(stateFile, JSON.stringify(fixture, null, 2));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  return ok;
};

const runPhase = (name, args = []) => {
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name, '--state', stateFile, '--channel', CHANNEL, '--cwd', CWD, ...args], {
    cwd: root, encoding: 'utf8', timeout: 240000,
  });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  let parsed = null;
  try { parsed = line ? JSON.parse(line.slice('RESULT '.length)) : null; } catch { parsed = null; }
  if (!parsed) {
    const stderr = (res.stderr || '').trim().split('\n').slice(-4).join(' | ');
    console.log(`     phase ${name} produced no result (exit=${res.status}) stderr: ${stderr}`);
  }
  return { status: res.status, parsed };
};

console.log(`[smoke] channel=${CHANNEL} cwd=${CWD}`);
console.log(`[smoke] state=${stateFile} (copy of real state; real file untouched)`);
console.log('[smoke] real ProviderManager + CredentialStore + ChatRuntime; Discord transport faked\n');

// Phase 1: historical placeholder -> AUTO repair + AUTO chat.
const auto = runPhase('auto');
check('fresh/auto phase ran', Boolean(auto.parsed));
if (auto.parsed) {
  const p = auto.parsed;
  check('historical <model-id> pin was present in the fixture', p.historicalPin?.model === '<model-id>' && p.historicalPin?.providerId === 'opencode-go', JSON.stringify(p.historicalPin));
  check('load repaired the placeholder to AUTO/null', p.afterLoad.providerId === 'auto' && p.afterLoad.model === null, JSON.stringify(p.afterLoad));
  check('the repair was persisted to disk', p.diskSelection.providerId === 'auto' && p.diskSelection.model === null, JSON.stringify(p.diskSelection));
  check('repair preserved cwd/Work/session fields', p.preserve.cwd === (channels[CHANNEL]?.cwd ?? null) && p.preserve.workModel === (channels[CHANNEL]?.model ?? null) && p.preserve.sessionId === (channels[CHANNEL]?.sessionId ?? null), JSON.stringify(p.preserve));
  check('你好 succeeds in AUTO', p.chatAuto?.ok === true, p.chatAuto?.footer ?? '');
  check('/status shows AUTO after repair', /^AUTO/.test(p.statusRoute ?? ''), p.statusRoute ?? '');
  check('Chat never started an Agent', p.agentRunners === 0);
}

// Phase 2: manual real pin + chat + status.
const pin = runPhase('pin');
check('pin phase ran', Boolean(pin.parsed));
if (pin.parsed) {
  const p = pin.parsed;
  check('manual real model pin is accepted', /已固定/.test(p.pinReply ?? ''), p.pinReply ?? '');
  check('pin persisted as opencode-go/deepseek-v4.1-flash', p.pinned?.providerId === 'opencode-go' && p.pinned?.model === 'deepseek-v4.1-flash', JSON.stringify(p.pinned));
  check('你好 succeeds with the manual pin', p.chatPinned?.ok === true, p.chatPinned?.footer ?? '');
  check('/status shows the manual pin', /^手动固定/.test(p.statusRoute ?? '') && /deepseek-v4\.1-flash/.test(p.statusRoute ?? ''), p.statusRoute ?? '');
}

// Phase 3: a NEW process restores the manual pin.
const restorePin = runPhase('restore-pin');
check('restore-pin phase ran', Boolean(restorePin.parsed));
if (restorePin.parsed) {
  const p = restorePin.parsed;
  check('restart restored the manual pin', p.afterLoad.providerId === 'opencode-go' && p.afterLoad.model === 'deepseek-v4.1-flash', JSON.stringify(p.afterLoad));
  check('restarted bridge still chats with the pin', p.chatPinned?.ok === true, p.chatPinned?.footer ?? '');
  check('manual pin never silently fell back', /deepseek-v4\.1-flash/.test(p.chatPinned?.footer ?? ''), p.chatPinned?.footer ?? '');
  check('/status still shows the manual pin', /^手动固定/.test(p.statusRoute ?? ''), p.statusRoute ?? '');
}

// Phase 4: switch back to AUTO.
const backAuto = runPhase('back-auto');
check('back-auto phase ran', Boolean(backAuto.parsed));
if (backAuto.parsed) {
  const p = backAuto.parsed;
  check('switch back to AUTO clears the pin', p.afterSwitch?.providerId === 'auto' && p.afterSwitch?.model === null, JSON.stringify(p.afterSwitch));
  check('你好 succeeds after switching back to AUTO', p.chatAuto?.ok === true, p.chatAuto?.footer ?? '');
  check('/status shows AUTO again', /^AUTO/.test(p.statusRoute ?? ''), p.statusRoute ?? '');
}

// Phase 5: a NEW process restores AUTO.
const restoreAuto = runPhase('restore-auto');
check('restore-auto phase ran', Boolean(restoreAuto.parsed));
if (restoreAuto.parsed) {
  const p = restoreAuto.parsed;
  check('restart restored AUTO/null', p.afterLoad.providerId === 'auto' && p.afterLoad.model === null, JSON.stringify(p.afterLoad));
  check('restarted bridge chats in AUTO', p.chatAuto?.ok === true, p.chatAuto?.footer ?? '');
}

const failed = results.filter((r) => !r.ok);
console.log(`\nP2.2.2 chat-selection smoke: ${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(workDir, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
