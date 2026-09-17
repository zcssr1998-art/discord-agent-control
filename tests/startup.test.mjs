import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureHookSecret } from '../src/hook-server.mjs';

// The real entry point (`node src/index.mjs`) is the one code path that cannot be
// exercised by the in-process tests, and it is the path the user actually runs.
// These tests boot it as a child process with a deliberately invalid token and
// check that it (a) brings the approval service up for real, (b) serves the hook
// contract over HTTP from a separate process, and (c) fails with an actionable
// message instead of a raw stack trace.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A fresh clone has no data/ directory (it is git-ignored), so make the shared
// secret deterministic instead of assuming a previous bridge run created it.
const SECRET = ensureHookSecret();

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bootBridge(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'not-a-real-token',
      DISCORD_OWNER_ID: '123456789012345678',
      LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dac-startup-logs-')),
      // Use the scripted executor so the startup backend probe is deterministic
      // and never reaches a real (possibly paid) provider.
      CLAUDE_COMMAND: path.join(ROOT, 'tests', 'fake-claude.mjs'),
      AGENT_BACKEND: 'workbuddy-free-dsf',
      ALLOW_PAID_FALLBACK: 'false',
      // Do not touch the real user-level agent settings from a test.
      DISCORD_AUTO_HOOK: '0',
      // Isolate the P2.2 single-instance lock: these tests boot the real entry
      // point while a real Jarvis may legitimately be running on the machine.
      JARVIS_INSTANCE_LOCK: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dac-startup-lock-')), 'instance.lock'),
      // A metered credential that must never survive into the agent process or
      // appear anywhere in the logs.
      ANTHROPIC_AUTH_TOKEN: 'sk-test-must-be-blocked',
      ...env,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
  return { child, exited, output: () => out };
}

async function waitForLine(getOutput, pattern, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(getOutput())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('the real entry point brings up a working approval service', async (t) => {
  const port = await freePort();
  const bridge = bootBridge({ APPROVAL_PORT: String(port) });
  t.after(() => { try { bridge.child.kill(); } catch { /* already gone */ } });

  const booted = await waitForLine(bridge.output, /\[hook\] listening at http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(booted, `the hook service never started. output:\n${bridge.output()}`);
  assert.match(bridge.output(), /\[backend\] expected=workbuddy-free-dsf paidFallback=disabled/);
  assert.match(bridge.output(), /\[backend\] WorkBuddy Free DSF confirmed\. Paid fallback: DISABLED\./);
  assert.match(bridge.output(), /\[routing\] paid provider routing not used/);
  // Whatever metered variables this machine happens to have must be reported as blocked.
  const blockedLine = bridge.output().split('\n').find((l) => l.startsWith('[backend] blocked credential vars:'));
  assert.ok(blockedLine, 'the bridge must report which credential variables it blocked');
  assert.match(blockedLine, /ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY/);
  assert.ok(!/sk-[A-Za-z0-9]/.test(bridge.output()), 'no credential value may ever be printed');

  // The hook contract must work over real HTTP from a different process.
  const allow = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(ROOT, 'package.json') },
      cwd: ROOT,
      session_id: 'startup-smoke',
      permission_mode: 'bypassPermissions',
    }),
  });
  const allowBody = await allow.json();
  assert.equal(allowBody.hookSpecificOutput.permissionDecision, 'allow');

  const denied = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
    body: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }),
  });
  assert.equal((await denied.json()).hookSpecificOutput.permissionDecision, 'deny', 'must fail closed');
});

test('a bad Discord token fails with an actionable message, not a raw stack', async (t) => {
  const port = await freePort();
  const bridge = bootBridge({ APPROVAL_PORT: String(port) });
  t.after(() => { try { bridge.child.kill(); } catch { /* already gone */ } });

  await waitForLine(bridge.output, /\[hook\] listening/);
  const { code, out } = await bridge.exited;

  assert.equal(code, 1, 'an unusable token must not leave a half-started bridge running');
  assert.match(out, /\[fatal\] Discord startup failed/);
  assert.match(out, /doctor:discord/, 'the message must tell the user how to diagnose it');
  assert.ok(!/^\s+at .*\(/m.test(out), 'no raw stack trace should be dumped at the user');
});

test('WorkBuddy quota does not take the shared V3 control plane offline', async (t) => {
  const port = await freePort();
  const bridge = bootBridge({ APPROVAL_PORT: String(port), WORKBUDDY_FAKE_BACKEND_ERROR: 'quota exceeded' });
  t.after(() => { try { bridge.child.kill(); } catch { /* already gone */ } });

  assert.ok(await waitForLine(bridge.output, /\[hook\] listening/), bridge.output());
  assert.match(bridge.output(), /WorkBuddy status=BLOCKED_BY_QUOTA/);
  assert.match(bridge.output(), /No provider fallback attempted/);
});

test('missing credentials are rejected before anything is started', async (t) => {
  const bridge = bootBridge({ DISCORD_TOKEN: '', DISCORD_OWNER_ID: '' });
  t.after(() => { try { bridge.child.kill(); } catch { /* already gone */ } });
  const { code, out } = await bridge.exited;
  assert.equal(code, 1);
  assert.match(out, /Missing required env: DISCORD_TOKEN, DISCORD_OWNER_ID/);
});
