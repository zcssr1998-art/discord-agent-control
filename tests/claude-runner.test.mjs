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

test('the model reported at init is captured for provider verification', async (t) => {
  const events = [];
  const runner = new ClaudeRunner({
    command: path.join(__dirname, 'fake-claude.mjs'),
    cwd: path.resolve(__dirname, '..'),
    onEvent: (e) => events.push(e),
  });
  t.after(() => runner.stop());
  await runner.send('probe');
  // fake-claude does not emit a model, so this asserts the "absent" branch is safe.
  assert.equal(runner.model, null);
});
