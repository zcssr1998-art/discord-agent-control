import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/claude-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEDGE = path.join(__dirname, 'fake-claude-wedge.mjs');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A runner against the "agent went silent" fixture. */
function wedgeRunner(mode, extra = {}) {
  return new ClaudeRunner({
    command: WEDGE,
    cwd: path.resolve(__dirname, '..'),
    extraEnv: { DAC_FAKE_WEDGE: mode },
    ...extra,
  });
}

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

// ---------------------------------------------------------------------------
// Regression: the real outage of 2026-09-14.
//
// The agent exited (or went silent) without emitting a `result`, and the bridge
// had no guard for it: send() stayed pending forever, the task stayed RUNNING,
// and the process was one unhandled pipe error away from taking the whole
// Discord control plane down with it.
// ---------------------------------------------------------------------------

test('a child that exits 0 without a result settles the request instead of hanging forever', async (t) => {
  const runner = wedgeRunner('exit0');
  t.after(() => runner.stop());

  await assert.rejects(
    () => runner.send('wedge'),
    (error) => error.code === 'AGENT_EXIT_NO_RESULT',
  );
  assert.equal(runner.busy, false, 'the task must not stay busy after the agent dies');
});

test('a hard child exit also settles the in-flight request', async (t) => {
  const runner = wedgeRunner('exit1');
  t.after(() => runner.stop());

  await assert.rejects(() => runner.send('wedge'), (error) => error.code === 'AGENT_EXIT');
  assert.equal(runner.busy, false);
});

test('a broken stdin pipe rejects the request instead of throwing an unhandled error', async (t) => {
  const runner = wedgeRunner('hang');
  t.after(() => runner.stop());

  let rejection = null;
  // Attach the handler synchronously: a promise that rejects before anyone
  // listens is exactly the class of bug under test.
  const pending = runner.send('wedge').catch((error) => { rejection = error; });
  await tick(120);

  // Exactly what a dying child does to the pipe. With no 'error' listener this
  // is an unhandled EventEmitter error: it throws, and an uncaught throw kills
  // the process — which is how the Discord control plane went offline.
  runner.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

  await pending;
  assert.match(String(rejection?.message), /EPIPE/);
  assert.equal(runner.busy, false, 'the failed request must not leave the channel busy');
});

test('stop() releases a pending request so !stop frees the channel immediately', async (t) => {
  const runner = wedgeRunner('hang');
  t.after(() => runner.stop());

  let rejection = null;
  const pending = runner.send('wedge').catch((error) => { rejection = error; });
  await tick(120);
  assert.equal(runner.busy, true);

  await runner.stop();
  await pending;

  assert.equal(rejection?.code, 'TASK_CANCELLED');
  assert.equal(runner.busy, false, 'killing the agent must release the task, not leave it RUNNING');
});

test('idleMs tracks how long the agent has been silent, for the control-plane watchdog', async (t) => {
  const runner = wedgeRunner('hang');
  t.after(() => runner.stop());

  const pending = runner.send('wedge').catch(() => {});
  await tick(120);
  assert.ok(runner.idleMs >= 100, `expected a non-trivial idle time, got ${runner.idleMs}`);
  await runner.stop();
  await pending;
});

