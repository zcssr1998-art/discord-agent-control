import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ExecutorManager } from '../src/executor-manager.mjs';
import { ensureGlobalHook } from '../src/global-hook.mjs';
import { PROTOCOL } from '../src/provider-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'scripts', 'approval-hook.mjs');

function startServer(secret) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${secret}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ok' },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runHook(env, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, DISCORD_BRIDGE_ACTIVE: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('the hook client uses the secret injected by the bridge (no stale file)', async (t) => {
  const { server, port } = await startServer('bridge-secret-0123456789');
  t.after(() => server.close());
  const env = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port), DISCORD_BRIDGE_SECRET: 'bridge-secret-0123456789' };

  const good = await runHook(env, { tool_name: 'Read', tool_input: { file_path: 'x' } });
  const goodBody = JSON.parse(good.out);
  assert.equal(goodBody.hookSpecificOutput.permissionDecision, 'allow', 'the bridge secret must authorise the hook');
  assert.equal(good.code, 0);
});

test('a wrong secret is still rejected with HTTP 401 and fails closed', async (t) => {
  const { server, port } = await startServer('the-real-secret');
  t.after(() => server.close());
  const env = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port), DISCORD_BRIDGE_SECRET: 'not-the-secret' };

  const bad = await runHook(env, { tool_name: 'Read', tool_input: { file_path: 'x' } });
  const badBody = JSON.parse(bad.out);
  assert.equal(badBody.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(badBody.hookSpecificOutput.permissionDecisionReason, /HTTP 401/);
});

test('the executor injects DISCORD_BRIDGE_SECRET into the agent child environment', () => {
  const bridgeEnv = { APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: '37911', DISCORD_BRIDGE_SECRET: 's3cr3t-value' };
  const executors = new ExecutorManager({ workbuddyCommand: 'x', workbuddyEnv: {}, bridgeEnv, probeVersion: async () => null });

  const workbuddy = executors.buildEnvironment('workbuddy', { id: 'workbuddy-free', protocol: PROTOCOL.WORKBUDDY }, null, null).env;
  assert.equal(workbuddy.DISCORD_BRIDGE_SECRET, 's3cr3t-value');

  const claude = executors.buildEnvironment('claude', { protocol: PROTOCOL.ANTHROPIC, baseUrl: 'http://127.0.0.1:1' }, 'cred', 'model').env;
  assert.equal(claude.DISCORD_BRIDGE_SECRET, 's3cr3t-value');
  assert.equal(claude.APPROVAL_PORT, '37911');
});

test('ensureGlobalHook points the user hook at this checkout and preserves other hooks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hook-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'node C:\\old\\repo\\scripts\\approval-hook.mjs' }] },
        { hooks: [{ type: 'command', command: 'node my-other-hook.mjs' }] },
      ],
    },
  }));

  const result = ensureGlobalHook({ root: ROOT, nodeExe: 'C:\\node.exe', home, logger: { warn() {} } });
  assert.equal(result.installed, true);
  assert.ok(result.changed, 'a stale hook must be repaired');

  const raw = fs.readFileSync(settingsFile, 'utf8');
  assert.notEqual(raw.charCodeAt(0), 0xFEFF, 'settings must be written without a BOM');
  const settings = JSON.parse(raw);
  const commands = settings.hooks.PreToolUse.flatMap((group) => group.hooks).map((hook) => hook.command);
  assert.ok(commands.some((command) => command.includes('my-other-hook.mjs')), 'foreign hooks must be preserved');
  assert.equal(commands.filter((command) => command.includes('approval-hook.mjs')).length, 1);
  assert.ok(commands.some((command) => command.includes(path.join(ROOT, 'scripts', 'approval-hook.mjs'))));
  assert.ok(!commands.some((command) => command.includes('C:\\old\\repo')));

  const second = ensureGlobalHook({ root: ROOT, nodeExe: 'C:\\node.exe', home, logger: { warn() {} } });
  assert.equal(second.changed, false, 'the repair must be idempotent');
});
