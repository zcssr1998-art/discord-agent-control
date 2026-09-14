import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoutingEnv, redactForLog, ROUTING_VARS } from '../src/win-env.mjs';

// Guards the failure mode the handover task calls out: the bridge silently
// running Claude against the official Anthropic endpoint because the DeepSeek
// routing variables were missing from the bridge process environment.

test('existing process env is trusted and no lookup happens', async () => {
  let called = false;
  const result = await resolveRoutingEnv(
    { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-flash[1m]' },
    { readEnv: async () => { called = true; return {}; } },
  );
  assert.equal(result.source, 'process-env');
  assert.equal(called, false);
  assert.deepEqual(result.env, {});
});

test('missing routing is repaired from the windows user environment', async () => {
  const result = await resolveRoutingEnv({}, {
    readEnv: async () => ({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
    }),
  });
  assert.equal(result.source, 'windows-user-env');
  assert.equal(result.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(result.added.sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
});

test('already-set variables are not overwritten by the fallback', async () => {
  const result = await resolveRoutingEnv({ ANTHROPIC_MODEL: 'mine' }, {
    readEnv: async () => ({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
    }),
  });
  assert.equal(result.env.ANTHROPIC_MODEL, undefined);
  assert.equal(result.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

test('unavailable routing is reported instead of pretending to work', async () => {
  const result = await resolveRoutingEnv({}, { readEnv: async () => ({}) });
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.env, {});
});

test('redaction never leaks token values into logs', () => {
  const redacted = redactForLog({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-supersecret',
    ANTHROPIC_MODEL: 'deepseek-flash[1m]',
  }, ROUTING_VARS);
  assert.equal(redacted.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(redacted.ANTHROPIC_MODEL, 'deepseek-flash[1m]');
  assert.equal(redacted.ANTHROPIC_AUTH_TOKEN, '<set:14>');
  assert.ok(!JSON.stringify(redacted).includes('supersecret'));
});
