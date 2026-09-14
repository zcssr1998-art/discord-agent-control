import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/claude-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('runner keeps process, streams events, and returns result', async (t) => {
  const events = [];
  const runner = new ClaudeRunner({
    command: path.join(__dirname, 'fake-claude.mjs'),
    cwd: path.resolve(__dirname, '..'),
    onEvent: (e) => events.push(e),
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
