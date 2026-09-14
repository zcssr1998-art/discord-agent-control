import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/claude-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('runner keeps process, streams events, and returns result', async (t) => {
  const events = [];
  const logged = [];
  const runner = new ClaudeRunner({
    command: path.join(__dirname, 'fake-claude.mjs'),
    cwd: path.resolve(__dirname, '..'),
    onEvent: (e) => events.push(e),
    onLog: (entry) => logged.push(entry),
  });
  t.after(() => runner.stop());

  const one = await runner.send('first');
  assert.equal(one.text, 'done:first');
  assert.equal(one.sessionId, 'fake-session-1');
  assert.equal(one.tools[0].name, 'Read');

  const two = await runner.send('second');
  assert.equal(two.text, 'done:second');
  assert.ok(events.some((e) => e.type === 'session'));
  assert.ok(events.some((e) => e.type === 'tool'));
});

test('thinking-token noise is logged but never dispatched', async (t) => {
  const events = [];
  const logged = [];
  const runner = new ClaudeRunner({
    command: path.join(__dirname, 'fake-claude.mjs'),
    cwd: path.resolve(__dirname, '..'),
    onEvent: (e) => events.push(e),
    onLog: (entry) => logged.push(entry),
  });
  t.after(() => runner.stop());
  await runner.send('probe');

  const dispatchedNoise = events.filter((e) => e.type === 'event' && e.event?.subtype === 'thinking_tokens');
  assert.equal(dispatchedNoise.length, 0, 'thinking_tokens must not reach the control plane');
  assert.ok(logged.some((e) => String(e.text).includes('thinking_tokens')), 'but the raw transcript keeps it');
});

test('the model and credential source reported at init are captured for backend verification', async (t) => {
  const events = [];
  const runner = new ClaudeRunner({
    command: path.join(__dirname, 'fake-claude.mjs'),
    cwd: path.resolve(__dirname, '..'),
    onEvent: (e) => events.push(e),
  });
  t.after(() => runner.stop());
  await runner.send('probe');

  assert.equal(runner.model, 'fake-model-1');
  assert.equal(runner.apiKeySource, 'www.workbuddy.ai', 'the backend identity must be captured, not guessed');
  const init = events.find((e) => e.type === 'init');
  assert.ok(init, 'an init event must be emitted for the control plane to verify the backend');
  assert.deepEqual(init.tools, ['Read', 'Write', 'Bash']);
});

test('blocked credential variables are removed from the child environment', async (t) => {
  const probe = path.join(__dirname, 'fake-env-probe.mjs');
  const runner = new ClaudeRunner({
    command: probe,
    cwd: path.resolve(__dirname, '..'),
    extraEnv: { ANTHROPIC_AUTH_TOKEN: 'paid-token', DAC_KEEP_ME: 'kept' },
    envUnset: ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'],
  });
  t.after(() => runner.stop());
  const result = await runner.send('probe');
  const env = JSON.parse(result.text);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, 'a metered credential must not reach the agent process');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DAC_KEEP_ME, 'kept', 'unrelated variables must survive');
  assert.equal(env.DISCORD_BRIDGE_ACTIVE, '1', 'the hook still needs to know it is a bridge session');
});
