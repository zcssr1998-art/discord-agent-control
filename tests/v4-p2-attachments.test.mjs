import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ChatRuntime } from '../src/chat-runtime.mjs';
import { ChatHistoryStore } from '../src/chat-history.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';
import { sanitizeFileName, isTrustedAttachmentUrl } from '../src/attachments.mjs';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function bytesResponse(bytes, contentType = 'application/octet-stream') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : name.toLowerCase() === 'content-type' ? contentType : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { return {}; },
  };
}

const OPENCODE_GO = {
  id: 'opencode-go', displayName: 'OpenCode Go', protocol: PROTOCOL.OPENCODE_GO,
  baseUrl: 'https://opencode.ai/zen/go', billingType: 'SUBSCRIPTION', credentialRef: 'provider:opencode-go',
  models: [
    { id: 'deepseek-v4.1-flash', transport: TRANSPORT.OPENAI_CHAT },
    { id: 'glm-5.3-flash', transport: TRANSPORT.OPENAI_CHAT },
  ],
};

function fakeProviders(profiles = [OPENCODE_GO]) {
  return {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) || null,
    hasCredential: () => true,
    listModels: async (id) => ({ models: profiles.find((profile) => profile.id === id)?.models || [] }),
  };
}

function makePlane({ fetchImpl, mode = 'chat', runner = null, profiles = [OPENCODE_GO], visionRoute = null } = {}) {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-attach-'));
  const state = new StateStore(path.join(dir, 'state.json'));
  if (mode !== 'chat') state.patchChannel(fake.channelId, { mode }, dir);
  const providers = fakeProviders(profiles);
  const chatHistory = new ChatHistoryStore({ file: path.join(dir, 'chat-history.json') });
  const chatRuntime = new ChatRuntime({
    providerManager: providers,
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: fetchImpl ?? (async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })),
    timeoutMs: 5000,
    visionRoute,
  });
  const plane = new DiscordControlPlane({
    config: {
      ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'workbuddy.js',
      notifyOnStart: false, includePartialMessages: false, progressThrottleMs: 1, stallNoticeMs: 1000,
      allowPaidFallback: false, taskTimeoutMs: 5000,
    },
    state,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 }),
    permissionManager: new PermissionManager(),
    providerManager: providers,
    chatRuntime,
    chatHistory,
    logger: new RunLogger(path.join(dir, 'logs')),
    backendState: { backend: { label: 'WorkBuddy', model: 'm', free: true }, allowPaidFallback: false },
    client: fake.client,
    autoLogin: false,
  });
  plane.attachmentInbox = path.join(dir, 'inbox');
  plane.attachmentFetch = fetchImpl;
  if (runner) plane.getRunner = async () => runner;
  return { fake, plane, chatHistory, dir };
}

const lastText = (fake) => fake.messages.at(-1)?.content ?? '';

test('Work attachment is downloaded once to a safe inbox and the task gets a local path manifest', async () => {
  let downloads = 0;
  const attachment = {
    id: 'a1', name: 'notes.txt', url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt',
    size: 11, contentType: 'text/plain',
  };
  const runner = {
    sessionId: 'sess-work', model: 'm', busy: false, sent: [], idleMs: 0,
    async send(prompt) { this.busy = true; this.sent.push(prompt); this.busy = false; return { text: 'done', sessionId: 'sess-work', durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
    async stop() { this.busy = false; },
  };
  const { fake, plane } = makePlane({
    mode: 'work', runner,
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) { downloads += 1; return bytesResponse(Buffer.from('hello world'), 'text/plain'); }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  plane.getRunner = async () => runner;
  await plane.start();
  await fake.sendAsUser({ content: 'read the attachment', attachments: [attachment] });

  assert.equal(downloads, 1, 'the attachment must be downloaded exactly once');
  assert.equal(runner.sent.length, 1);
  assert.match(runner.sent[0], /Discord 附件已下载/);
  const match = runner.sent[0].match(/-> `([^`]+)`/);
  assert.ok(match, 'the manifest must contain a local path');
  const local = match[1];
  assert.ok(local.startsWith(plane.attachmentInbox), 'the file must live inside the inbox');
  assert.ok(fs.existsSync(local), 'the downloaded file must exist on disk');
  assert.ok(!local.includes('..'), 'no traversal in the local path');
});

test('attachment filenames are sanitized and untrusted URLs are rejected', () => {
  assert.equal(sanitizeFileName('../../evil.txt'), 'evil.txt');
  assert.equal(sanitizeFileName('..\\..\\evil.sh'), 'evil.sh');
  assert.equal(sanitizeFileName('a/b\\c:d?.txt'), 'c_d_.txt');
  assert.equal(sanitizeFileName('...'), 'attachment');
  assert.ok(!isTrustedAttachmentUrl('http://cdn.discordapp.com/x')); // must be https
  assert.ok(!isTrustedAttachmentUrl('https://evil.example.com/x'));
  assert.ok(isTrustedAttachmentUrl('https://cdn.discordapp.com/attachments/1/2/x'));
  assert.ok(isTrustedAttachmentUrl('https://media.discordapp.net/x'));
});

test('an untrusted Work attachment is refused without downloading', async () => {
  let downloads = 0;
  const runner = {
    sessionId: 's', model: 'm', busy: false, sent: [], idleMs: 0,
    async send(prompt) { this.sent.push(prompt); return { text: 'done', sessionId: 's', durationMs: 1, tools: [], isError: false, costUsd: 0 }; },
    async stop() {},
  };
  const { fake, plane } = makePlane({
    mode: 'work', runner,
    fetchImpl: async () => { downloads += 1; return bytesResponse(Buffer.from('x')); },
  });
  plane.getRunner = async () => runner;
  await plane.start();
  await fake.sendAsUser({
    content: 'read it',
    attachments: [{ name: 'evil.txt', url: 'https://evil.example.com/evil.txt', size: 1, contentType: 'text/plain' }],
  });
  assert.equal(downloads, 0);
  assert.match(runner.sent[0], /未下载/);
});

test('a binary Chat attachment is not silently ignored', async () => {
  const bodies = [];
  const { fake, plane } = makePlane({
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) return bytesResponse(Buffer.from([0, 1, 2, 3]), 'application/octet-stream');
      bodies.push(JSON.parse(options.body));
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({
    content: '看看这个',
    attachments: [{ name: 'blob.bin', url: 'https://cdn.discordapp.com/attachments/1/2/blob.bin', size: 4, contentType: 'application/octet-stream' }],
  });
  const content = bodies[0].messages.at(-1).content;
  const joined = Array.isArray(content) ? content.map((part) => part.text || '').join('\n') : content;
  assert.match(joined, /无法在 Chat 中读取/);
  assert.match(joined, /Work/);
});

test('a text Chat attachment is bounded and included in the turn', async () => {
  const bodies = [];
  const big = 'x'.repeat(20000);
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) return bytesResponse(Buffer.from(big), 'text/plain');
      bodies.push(JSON.parse(options.body));
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({
    content: '总结附件',
    attachments: [{ name: 'notes.txt', url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt', size: 20000, contentType: 'text/plain' }],
  });
  const content = bodies[0].messages.at(-1).content;
  const text = content.map((part) => part.text || '').join('\n');
  assert.match(text, /notes\.txt/);
  assert.ok(text.length < 13000, `bounded text length was ${text.length}`);
  const stored = chatHistory.get(fake.channelId).messages[0].content;
  assert.ok(stored.length < 13000, 'history must retain only bounded extracted text');
});

test('an image Chat turn builds a correct OpenAI/LiteLLM multimodal payload', async () => {
  const LITELLM = {
    id: 'litellm', displayName: 'LiteLLM Gateway', protocol: PROTOCOL.OPENAI,
    baseUrl: 'http://127.0.0.1:4000/v1', billingType: 'SUBSCRIPTION', credentialRef: 'provider:litellm',
    models: [{ id: 'vision', displayName: 'vision' }],
  };
  const bodies = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { fake, plane } = makePlane({
    profiles: [LITELLM],
    visionRoute: { providerId: 'litellm', model: 'vision' },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) return bytesResponse(png, 'image/png');
      bodies.push(JSON.parse(options.body));
      return jsonResponse(200, { choices: [{ message: { content: '我看到一张图片' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({
    content: '这是什么',
    attachments: [{ name: 'shot.png', url: 'https://cdn.discordapp.com/attachments/1/2/shot.png', size: png.length, contentType: 'image/png' }],
  });
  const content = bodies[0].messages.at(-1).content;
  const image = content.find((part) => part.type === 'image_url');
  assert.ok(image, 'the OpenAI payload must contain an image_url part');
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.match(lastText(fake), /我看到一张图片/);
});

test('Anthropic transport maps a neutral image part to an image block', async () => {
  const ANTHROPIC = {
    id: 'anthropic-direct', displayName: 'Anthropic', protocol: PROTOCOL.ANTHROPIC,
    baseUrl: 'https://api.anthropic.com', billingType: 'SUBSCRIPTION', credentialRef: 'provider:anthropic',
    models: [{ id: 'claude-vision' }],
  };
  let body = null;
  const runtime = new ChatRuntime({
    providerManager: fakeProviders([ANTHROPIC]),
    credentialStore: { get: () => 'secret-key' },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }); },
    timeoutMs: 5000,
  });
  await runtime.send({
    providerId: 'anthropic-direct', model: 'claude-vision',
    messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }],
  });
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
});

test('a provider fallback does not re-download the attachment or duplicate history', async () => {
  let downloads = 0;
  const { fake, plane, chatHistory } = makePlane({
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) { downloads += 1; return bytesResponse(Buffer.from('file body'), 'text/plain'); }
      const model = JSON.parse(options.body).model;
      if (model === 'deepseek-v4.1-flash') return jsonResponse(429, { error: { message: 'rate limited' } });
      return jsonResponse(200, { choices: [{ message: { content: 'glm ok' } }] });
    },
  });
  await plane.start();
  await fake.sendAsUser({
    content: '处理附件',
    attachments: [{ name: 'n.txt', url: 'https://cdn.discordapp.com/attachments/1/2/n.txt', size: 9, contentType: 'text/plain' }],
  });
  assert.equal(downloads, 1, 'the attachment is downloaded once even with a provider retry');
  assert.deepEqual(chatHistory.get(fake.channelId).messages.map((m) => m.role), ['user', 'assistant']);
});
