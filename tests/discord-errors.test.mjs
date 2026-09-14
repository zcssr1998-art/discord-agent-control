import test from 'node:test';
import assert from 'node:assert/strict';
import { explainDiscordLoginError, isIntentError } from '../src/discord-errors.mjs';
import { normalizeProxyUrl, resolveDiscordProxy } from '../src/win-env.mjs';

test('a disabled privileged intent is explained with the exact click', () => {
  assert.equal(isIntentError('Used disallowed intents'), true);
  const hint = explainDiscordLoginError('Used disallowed intents');
  assert.match(hint, /Message Content Intent/);
  assert.match(hint, /Developer Portal/);
  assert.match(hint, /Privileged Gateway Intents/);
});

test('a blocked network points at the proxy, not the token', () => {
  const hint = explainDiscordLoginError('Connect Timeout Error (attempted addresses: 108.160.165.173:443)');
  assert.match(hint, /DISCORD_PROXY/);
  assert.match(hint, /system proxy/);
  assert.ok(!/token/i.test(hint), 'must not send the user chasing a token that is fine');
});

test('an auth failure points at the token', () => {
  assert.match(explainDiscordLoginError('Used disallowed intents'.replace('Used disallowed intents', '401: Unauthorized')), /DISCORD_TOKEN/);
  assert.match(explainDiscordLoginError('An invalid token was provided'), /DISCORD_TOKEN/);
});

test('an unknown failure still gives a next step', () => {
  assert.match(explainDiscordLoginError('something odd'), /doctor:discord/);
});

test('normalizeProxyUrl handles bare host:port and per-scheme lists', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(normalizeProxyUrl('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7891');
  assert.equal(normalizeProxyUrl('http=127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl('   '), null);
  assert.equal(normalizeProxyUrl('ftp=1.2.3.4:21'), null, 'an unusable scheme list yields nothing');
});

test('resolveDiscordProxy prefers the explicit setting, then the system proxy', async () => {
  const explicit = await resolveDiscordProxy('127.0.0.1:9999', { readSystemProxy: async () => 'http://127.0.0.1:7897' });
  assert.equal(explicit.proxyUrl, 'http://127.0.0.1:9999');
  assert.equal(explicit.source, 'env');

  const system = await resolveDiscordProxy(undefined, { readSystemProxy: async () => 'http://127.0.0.1:7897' });
  assert.equal(system.proxyUrl, 'http://127.0.0.1:7897');
  assert.equal(system.source, 'windows-system');

  const none = await resolveDiscordProxy(undefined, { readSystemProxy: async () => null });
  assert.equal(none.proxyUrl, null);
  assert.equal(none.source, 'none');
});

test('DISCORD_PROXY=off really disables proxying instead of being ignored', async () => {
  let called = false;
  const off = await resolveDiscordProxy('off', { readSystemProxy: async () => { called = true; return 'http://127.0.0.1:7897'; } });
  assert.equal(off.proxyUrl, null);
  assert.equal(off.source, 'disabled');
  assert.equal(called, false, 'an explicit off must not fall back to the system proxy');
});
