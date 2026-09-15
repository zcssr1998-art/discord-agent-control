#!/usr/bin/env node
/**
 * Real-machine P2 smoke — persistent panel, Chat history/context, Work thread.
 *
 * Real: the LiteLLM gateway / OpenCode Go direct Chat route, the Claude Code CLI
 * (through the local Anthropic <-> OpenAI adapter), the PreToolUse hook server,
 * ApprovalManager, PermissionManager, ExecutorManager, ProviderManager, the real
 * DiscordControlPlane, ChatHistoryStore, the WorkspaceScheduler and the
 * filesystem.
 * Fake: the Discord transport only (tests/helpers/fake-discord.mjs), because the
 * bridge deliberately ignores bot-authored messages and so cannot send as the
 * human owner.
 *
 *   node scripts/p2-e2e.mjs
 *
 * The human button-clicking smoke still needs the owner; this is its
 * machine-side companion.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { ProviderManager } from '../src/provider-manager.mjs';
import { CredentialStore } from '../src/credential-store.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ChatHistoryStore } from '../src/chat-history.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { readOpenCodeGoKey, loadLiteLLMConfig, checkLiteLLMHealth } from '../src/litellm.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

const MODEL = process.env.P2_SMOKE_MODEL || 'deepseek-v4.1-flash';
const VISION_MODEL = process.env.P2_SMOKE_VISION_MODEL || 'deepseek-v4-flash-vision-exp';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
/** A small solid-red PNG so a real vision model has something unambiguous to read. */
function redPng(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = row + 1 + x * 3;
      raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function bytesResponse(bytes, contentType) {
  return {
    ok: true, status: 200,
    headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(bytes.length) : n.toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { return {}; },
  };
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('HARD_TIMEOUT'); process.exit(2); }, 420000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-e2e-'));

function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'smoke@local'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'P2 Smoke'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# p2 smoke\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'chore: init'], { cwd: dir });
  return dir;
}

async function main() {
  const credentials = new CredentialStore(path.join(tmp, 'credentials.json'));
  const key = readOpenCodeGoKey();
  if (!key) throw new Error('no OpenCode Go credential found');
  credentials.set('provider:opencode-go', key);
  const providers = new ProviderManager({ file: path.join(tmp, 'providers.json'), credentialStore: credentials });

  const litellm = loadLiteLLMConfig(process.env, { root: process.cwd() });
  let gateway = { ok: false, detail: 'disabled' };
  if (litellm.enabled) {
    if (litellm.masterKey) credentials.set('provider:litellm', litellm.masterKey);
    providers.registerLitellm({ baseUrl: litellm.baseUrl, billingType: litellm.billingType });
    gateway = await checkLiteLLMHealth({ healthUrl: litellm.healthUrl, masterKey: litellm.masterKey, timeoutMs: litellm.timeoutMs });
  }
  console.log(`[gateway] enabled=${litellm.enabled} health=${gateway.ok ? 'UP' : 'DOWN'} (${gateway.detail})`);
  check('G1 the real LiteLLM gateway is reachable (or the direct route is available)', gateway.ok || Boolean(key), gateway.detail);

  // ---- Phase A: real Chat multi-turn context + persisted history ------------
  {
    const repo = makeRepo('p2-chat');
    const fake = new FakeDiscord();
    const state = new StateStore(path.join(repo, 'state.json'));
    const chatHistory = new ChatHistoryStore({ file: path.join(repo, 'chat-history.json') });
    const red = redPng();
    const chatRuntime = new ChatRuntime({
      providerManager: providers, credentialStore: credentials, timeoutMs: 60000,
      allowMeteredFallback: false,
      visionRoute: key ? { providerId: 'opencode-go', model: VISION_MODEL } : null,
    });
    const plane = new DiscordControlPlane({
      config: {
        ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: repo, claudeCommand: 'claude',
        notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1000, stallNoticeMs: 60000,
        allowPaidFallback: false, taskTimeoutMs: 120000,
      },
      state, approvalManager: new ApprovalManager({ timeoutMs: 60000 }), permissionManager: new PermissionManager(),
      providerManager: providers, credentialStore: credentials, chatRuntime, chatHistory,
      logger: new RunLogger(path.join(repo, 'logs')),
      backendState: { backend: { label: 'opencode-go', model: MODEL }, allowPaidFallback: false },
      client: fake.client, autoLogin: false,
    });
    await plane.start();

    const first = await fake.sendAsUser({ content: '请记住这个数字：7391。只回复 OK。' });
    const firstReply = fake.messagesIn(fake.channelId).at(-1)?.content ?? '';
    check('C1 the real Chat route answered turn 1', /💬 Chat/.test(firstReply), firstReply.slice(0, 80).replace(/\n/g, ' '));

    await fake.sendAsUser({ content: '我刚才让你记住的数字是多少？只回复数字。' });
    const secondReply = fake.messagesIn(fake.channelId).at(-1)?.content ?? '';
    check('C2 turn 2 used turn-1 context (the model recalled 7391)', /7391/.test(secondReply), secondReply.slice(0, 120).replace(/\n/g, ' '));

    const stats = chatHistory.stats(fake.channelId);
    check('C3 four role messages were persisted', stats.messages === 4, JSON.stringify(stats));

    const reloaded = new ChatHistoryStore({ file: path.join(repo, 'chat-history.json') });
    check('C4 Chat history survives a store reload', reloaded.get(fake.channelId).messages.length === 4);

    await fake.sendAsUser({ content: '!panel' });
    const panel = fake.messagesIn(fake.channelId).at(-1);
    check('C5 !panel rendered with the P2 controls', /Jarvis Control Panel/.test(panel.content) && panel.buttonIds.includes('panel:newwork'));

    // Real image turn through the real vision model. The attachment URL is a
    // trusted Discord CDN host and the bytes are served locally, but the model
    // call itself is real (OpenCode Go direct vision route).
    plane.attachmentInbox = path.join(repo, 'inbox');
    plane.attachmentFetch = async (url) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) return bytesResponse(red, 'image/png');
      throw new Error(`unexpected fetch ${url}`);
    };
    await fake.sendAsUser({
      content: '这张图片是什么颜色？只回答颜色。',
      attachments: [{ name: 'red.png', url: 'https://cdn.discordapp.com/attachments/1/2/red.png', size: red.length, contentType: 'image/png' }],
    });
    const visionReply = fake.messagesIn(fake.channelId).at(-1)?.content ?? '';
    check('C6 the real vision route understood the image', /红|red/i.test(visionReply), visionReply.slice(0, 140).replace(/\n/g, ' '));

    await plane.stopAll({ reason: 'phase A done' });
    void first;
  }

  // ---- Phase B: real Work thread created from the panel modal --------------
  {
    const repo = makeRepo('p2-work');
    const executors = new ExecutorManager({ workbuddyCommand: 'claude', workbuddyEnv: process.env, bridgeEnv: {} });
    await executors.discover();
    for (const executor of executors.list()) console.log(`[executor] ${executor.id}=${executor.status} ${executor.version || ''}`);

    const secret = ensureHookSecret();
    const approvals = new ApprovalManager({ timeoutMs: 120000 });
    approvals.setPresenter((req) => approvals.resolve(req.id, 'allow-once'));
    const permissions = new PermissionManager();
    const hookServer = createHookServer({
      config: { defaultCwd: repo, autoAllowWorkspaceWrites: true, autoAllowTestCommands: true },
      approvalManager: approvals, permissionManager: permissions, secret,
    });
    const port = await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', () => resolve(hookServer.address().port)));
    executors.bridgeEnv = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port), DISCORD_BRIDGE_SECRET: secret };

    const fake = new FakeDiscord({ threadCapable: true });
    const state = new StateStore(path.join(repo, 'state.json'));
    state.patchChannel(fake.channelId, {
      mode: 'chat', cwd: repo, executorId: 'claude', providerId: 'opencode-go', model: MODEL,
    }, repo);
    const plane = new DiscordControlPlane({
      config: {
        ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: repo, claudeCommand: 'claude',
        approvalHost: '127.0.0.1', approvalPort: port, approvalTimeoutMs: 120000,
        notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1000, stallNoticeMs: 60000,
        allowPaidFallback: false, taskTimeoutMs: 180000,
      },
      state, approvalManager: approvals, permissionManager: permissions,
      providerManager: providers, credentialStore: credentials, executorManager: executors,
      logger: new RunLogger(path.join(repo, 'logs')),
      backendState: { backend: { label: 'opencode-go', model: MODEL }, allowPaidFallback: false },
      client: fake.client, autoLogin: false,
    });
    await plane.start();

    await fake.sendAsUser({ content: '!panel', guildId: 'guild-smoke' });
    await fake.clickButton('panel:newwork');
    const startedAt = Date.now();
    await fake.submitModal('workmodal:task', {
      values: { task: 'Create a file named p2-panel-ok.txt containing exactly P2_PANEL_OK, then reply with only DONE.' },
      guildId: 'guild-smoke',
    });
    await tick(1500);
    const thread = fake.threads[0];
    check('W1 the panel modal created exactly one Work thread', fake.threads.length === 1);
    check('W2 the guild parent stayed Chat', plane.sessionManager.get(fake.channelId).mode === 'chat');
    if (thread) {
      // Wait for the real agent to finish.
      for (let i = 0; i < 120 && !fs.existsSync(path.join(repo, 'p2-panel-ok.txt')); i += 1) await tick(1000);
      const status = fake.messagesIn(thread.id).map((m) => m.content).join('\n');
      check('W3 the real Agent completed in the panel Work thread', /✅ 已完成/.test(status), `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      check('W4 the real Agent created the file',
        fs.existsSync(path.join(repo, 'p2-panel-ok.txt'))
        && fs.readFileSync(path.join(repo, 'p2-panel-ok.txt'), 'utf8').includes('P2_PANEL_OK'));
    }
    await plane.stopAll({ reason: 'phase B done' });
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
  console.error('[p2-e2e fatal]', error?.stack || error);
  process.exit(1);
});
