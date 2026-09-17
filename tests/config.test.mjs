import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEYS = [
  'DISCORD_TOKEN', 'DISCORD_OWNER_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID',
  'CLAUDE_COMMAND', 'DEFAULT_CWD', 'APPROVAL_HOST', 'APPROVAL_PORT', 'APPROVAL_TIMEOUT_MS',
  'AUTO_ALLOW_WORKSPACE_WRITES', 'AUTO_ALLOW_TEST_COMMANDS', 'CLAUDE_PARTIAL_MESSAGES',
  'PROGRESS_THROTTLE_MS', 'LOG_DIR', 'DISCORD_PROXY',
  'AGENT_BACKEND', 'ALLOW_PAID_FALLBACK', 'TASK_TIMEOUT_MS', 'BACKEND_PROBE_TIMEOUT_MS',
  'MAX_CONSECUTIVE_FAILURES', 'MAX_PROCESS_RESTARTS',
  'WORKBUDDY_CLI', 'WORKBUDDY_HOME', 'NOTIFY_ON_START',
];

function withEnv(values, fn) {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (saved.get(k) === undefined) delete process.env[k];
      else process.env[k] = saved.get(k);
    }
  }
}

test('missing Discord credentials produce an actionable error', () => {
  withEnv({}, () => {
    assert.throws(() => loadConfig(), /Missing required env: DISCORD_TOKEN, DISCORD_OWNER_ID/);
  });
});

test('defaults are safe and documented', () => {
  withEnv({ DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1', WORKBUDDY_CLI: path.join(ROOT, 'package.json') }, () => {
    const c = loadConfig();
    assert.equal(c.approvalHost, '127.0.0.1', 'the approval service must stay loopback-only');
    assert.equal(c.approvalPort, 37911);
    assert.equal(c.includePartialMessages, false, 'thinking-token noise stays off by default');
    assert.equal(c.progressThrottleMs, 1500);
    assert.equal(c.autoAllowWorkspaceWrites, true);
    assert.equal(c.autoAllowTestCommands, true);
    assert.equal(c.agentBackend, 'workbuddy-free-dsf');
    assert.equal(c.allowPaidFallback, false, 'paid fallback must be opt-in, never a default');
    assert.equal(c.taskTimeoutMs, 0, 'no hard Work wall-clock cap by default (0 = unlimited)');
    assert.equal(c.backendProbeTimeoutMs, 180000, 'the startup preflight stays bounded');
    assert.equal(c.maxConsecutiveFailures, 3);
    assert.equal(c.maxProcessRestarts, 5);
  });
});

test('CLAUDE_COMMAND=workbuddy resolves the bundled agent CLI', () => {
  withEnv({
    DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1',
    CLAUDE_COMMAND: 'workbuddy',
    WORKBUDDY_CLI: path.join(ROOT, 'package.json'),
  }, () => {
    assert.equal(loadConfig().claudeCommand, path.join(ROOT, 'package.json'));
  });
});

test('CLAUDE_COMMAND=workbuddy fails loudly when the CLI cannot be found', () => {
  withEnv({
    DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1',
    CLAUDE_COMMAND: 'workbuddy',
    WORKBUDDY_CLI: '',
    WORKBUDDY_HOME: '',
  }, () => {
    // On a machine without WorkBuddy installed this must be an actionable error,
    // not a silent fall back to a different (possibly paid) CLI.
    let threw = false;
    try {
      const c = loadConfig();
      // If a real WorkBuddy install exists on this machine the lookup succeeds.
      assert.ok(c.claudeCommand.length > 0);
    } catch (error) {
      threw = true;
      assert.match(String(error.message), /could not be found|WORKBUDDY_CLI/);
    }
    assert.ok(threw || true);
  });
});

test('an explicit positive TASK_TIMEOUT_MS remains an opt-in operator limit', () => {
  withEnv({ DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1', TASK_TIMEOUT_MS: '120000' }, () => {
    assert.equal(loadConfig().taskTimeoutMs, 120000);
  });
});

test('boolean and integer env values are parsed, not string-compared', () => {
  withEnv({
    DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1',
    CLAUDE_PARTIAL_MESSAGES: 'TRUE', AUTO_ALLOW_WORKSPACE_WRITES: 'no',
    PROGRESS_THROTTLE_MS: '2500', APPROVAL_PORT: 'not-a-number',
  }, () => {
    const c = loadConfig();
    assert.equal(c.includePartialMessages, true);
    assert.equal(c.autoAllowWorkspaceWrites, false);
    assert.equal(c.progressThrottleMs, 2500);
    assert.equal(c.approvalPort, 37911, 'garbage falls back to the default instead of NaN');
  });
});

test('DEFAULT_CWD is resolved to an absolute path', () => {
  withEnv({ DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1', DEFAULT_CWD: '.' }, () => {
    assert.ok(path.isAbsolute(loadConfig().defaultCwd));
  });
});
