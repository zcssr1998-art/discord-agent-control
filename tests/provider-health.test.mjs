import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderHealthRegistry, classifyProviderFailure } from '../src/provider-health.mjs';

test('provider failures enter cooldown and success clears it', () => {
  let now = 1000;
  const health = new ProviderHealthRegistry({ now: () => now, cooldownsMs: { RATE_LIMIT: 100, UNKNOWN: 10 } });
  const failure = health.noteFailure('p', 'm', Object.assign(new Error('rate'), { code: 'RATE_LIMIT' }));
  assert.equal(failure.cooldownMs, 100);
  assert.equal(health.canTry('p', 'm'), false);
  now = 1101;
  assert.equal(health.canTry('p', 'm'), true);
  health.noteSuccess('p', 'm');
  assert.equal(health.snapshot('p', 'm').status, 'healthy');
});

test('status and error text are classified without provider-specific branches', () => {
  assert.equal(classifyProviderFailure({ status: 429 }), 'RATE_LIMIT');
  assert.equal(classifyProviderFailure(new Error('额度不足')), 'QUOTA');
  assert.equal(classifyProviderFailure(new Error('request timed out')), 'TIMEOUT');
});
