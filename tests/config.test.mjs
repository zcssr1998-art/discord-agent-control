import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';

const KEYS = [
  'DISCORD_TOKEN', 'DISCORD_OWNER_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID',
  'CLAUDE_COMMAND', 'DEFAULT_CWD', 'APPROVAL_HOST', 'APPROVAL_PORT', 'APPROVAL_TIMEOUT_MS',
  'AUTO_ALLOW_WORKSPACE_WRITES', 'AUTO_ALLOW_TEST_COMMANDS', 'CLAUDE_PARTIAL_MESSAGES',
  'PROGRESS_THROTTLE_MS', 'LOG_DIR',
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
  withEnv({ DISCORD_TOKEN: 't', DISCORD_OWNER_ID: '1' }, () => {
    const c = loadConfig();
    assert.equal(c.claudeCommand, 'claude');
    assert.equal(c.approvalHost, '127.0.0.1', 'the approval service must stay loopback-only');
    assert.equal(c.approvalPort, 37911);
    assert.equal(c.includePartialMessages, false, 'thinking-token noise stays off by default');
    assert.equal(c.progressThrottleMs, 1500);
    assert.equal(c.autoAllowWorkspaceWrites, true);
    assert.equal(c.autoAllowTestCommands, true);
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
