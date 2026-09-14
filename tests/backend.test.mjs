import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBackend,
  stripPaidCredentials,
  assertBackendAllowed,
  billingRoute,
  describeBackendLine,
  BACKEND,
} from '../src/backend.mjs';
import { RunLimits, withTimeout } from '../src/limits.mjs';

test('the WorkBuddy gateway is recognised as the free backend', () => {
  const backend = classifyBackend({ apiKeySource: 'www.workbuddy.ai', model: 'fast-model' });
  assert.equal(backend.id, BACKEND.WORKBUDDY);
  assert.equal(backend.label, 'WorkBuddy Free DSF');
  assert.equal(backend.free, true);
  assert.equal(backend.model, 'fast-model');
  assert.equal(billingRoute(backend), 'WorkBuddy Free');
});

test('a third-party apiKeySource is NOT treated as the free backend', () => {
  for (const source of ['api.anthropic.com', 'api.deepseek.com', 'api.openai.com']) {
    const backend = classifyBackend({ apiKeySource: source });
    assert.equal(backend.id, BACKEND.UNKNOWN, `${source} must not pass as free`);
    assert.equal(backend.free, false);
    assert.match(billingRoute(backend), /UNCONFIRMED/);
  }
});

test('a missing apiKeySource is unknown, not assumed free', () => {
  const backend = classifyBackend({});
  assert.equal(backend.free, false);
  assert.equal(backend.apiKeySource, null);
});

test('paid credentials are removed by name and never echoed', () => {
  const env = {
    ANTHROPIC_AUTH_TOKEN: 'sk-secret',
    ANTHROPIC_API_KEY: 'sk-secret2',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    DEEPSEEK_API_KEY: 'sk-secret3',
    OPENAI_API_KEY: 'sk-secret4',
    PATH: '/usr/bin',
    DISCORD_TOKEN: 'discord',
  };
  const removed = stripPaidCredentials(env);
  assert.deepEqual(removed.sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].sort());
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, '/usr/bin', 'unrelated variables survive');
  assert.equal(env.DISCORD_TOKEN, 'discord');
  assert.ok(!JSON.stringify(removed).includes('sk-'), 'only names are reported, never values');
});

test('fail closed: a non-WorkBuddy backend is refused when paid fallback is off', () => {
  const paid = classifyBackend({ apiKeySource: 'api.deepseek.com' });
  const verdict = assertBackendAllowed(paid, { allowPaidFallback: false, expected: BACKEND.WORKBUDDY });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /paid fallback is disabled/);

  const free = classifyBackend({ apiKeySource: 'www.workbuddy.ai' });
  assert.equal(assertBackendAllowed(free, { allowPaidFallback: false }).ok, true);
});

test('an explicit opt-in is the only way a paid backend may run', () => {
  const paid = classifyBackend({ apiKeySource: 'api.deepseek.com' });
  const verdict = assertBackendAllowed(paid, { allowPaidFallback: true });
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /allowed by configuration/);
});

test('!status lines never reduce the backend to a bare provider name', () => {
  const lines = describeBackendLine(classifyBackend({ apiKeySource: 'www.workbuddy.ai', model: 'fast-model' }), { allowPaidFallback: false });
  const text = lines.join('\n');
  assert.match(text, /Backend: WorkBuddy Free DSF/);
  assert.match(text, /Model: fast-model/);
  assert.match(text, /Billing route: WorkBuddy Free/);
  assert.match(text, /Paid fallback: disabled/);
  assert.ok(!/^DeepSeek$/m.test(text));
});

test('consecutive failures eventually refuse to start more work', () => {
  const limits = new RunLimits({ maxConsecutiveFailures: 2 });
  assert.equal(limits.blocked('c').blocked, false);
  limits.noteFailure('c', new Error('boom'));
  assert.equal(limits.blocked('c').blocked, false);
  limits.noteFailure('c', new Error('boom again'));
  const verdict = limits.blocked('c');
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /consecutive failures/);
  assert.match(verdict.reason, /!reset/);

  limits.noteSuccess('c');
  assert.equal(limits.blocked('c').blocked, false, 'a success clears the counter');
});

test('process restarts are capped too', () => {
  const limits = new RunLimits({ maxProcessRestarts: 2 });
  limits.noteProcessRestart('c');
  limits.noteProcessRestart('c');
  assert.equal(limits.blocked('c').blocked, true);
  limits.reset('c');
  assert.equal(limits.blocked('c').blocked, false);
});

test('a hung task is killed by the wall-clock cap instead of running forever', async () => {
  let killed = false;
  await assert.rejects(
    withTimeout(new Promise(() => {}), 40, { label: 'task', onTimeout: () => { killed = true; } }),
    /task exceeded/,
  );
  assert.equal(killed, true, 'the timeout must run the cleanup that stops the agent');
});

test('withTimeout passes a normal result straight through', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000), 'ok');
  assert.equal(await withTimeout(Promise.resolve('ok'), 0), 'ok', 'a disabled timeout must not interfere');
});
