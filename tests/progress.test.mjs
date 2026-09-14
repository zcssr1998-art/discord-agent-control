import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskProgress, ThrottledEditor, STATE } from '../src/progress.mjs';

test('progress walks CREATED -> RUNNING -> TESTING and renders low-noise status', () => {
  const p = new TaskProgress({ cwd: 'C:\\proj', startedAt: Date.now() });
  assert.equal(p.state, STATE.CREATED);

  p.recordTool({ name: 'Read', input: { file_path: 'src/a.js' } });
  assert.equal(p.state, STATE.RUNNING);

  p.recordTool({ name: 'Edit', input: { file_path: 'src/a.js' } });
  p.recordTool({ name: 'Bash', input: { command: 'npm test' } });
  assert.equal(p.state, STATE.TESTING);
  assert.equal(p.tests, '运行中');

  const rendered = p.render();
  assert.match(rendered, /🧪 正在测试/);
  assert.match(rendered, /📁 当前项目：`C:\\proj`/);
  assert.match(rendered, /Read×1 · Edit×1 · Bash×1/);
  assert.ok(rendered.split('\n').length <= 12, 'status must stay reasonably short');
});

test('a non-test shell command moves the status out of TESTING', () => {
  const p = new TaskProgress({ cwd: '/p' });
  p.recordTool({ name: 'Bash', input: { command: 'npm test' } });
  assert.equal(p.state, STATE.TESTING);
  p.recordTool({ name: 'Bash', input: { command: 'git commit -m "x"' } });
  assert.equal(p.state, STATE.RUNNING, 'must not stay stuck on TESTING during git work');
});

test('progress surfaces test totals parsed from agent text', () => {
  const p = new TaskProgress({ cwd: '/p' });
  p.recordText('# tests 10\n# pass 10\n# fail 0');
  assert.equal(p.tests, '通过 10');
  p.recordText('# fail 2');
  assert.equal(p.tests, '失败 2');
});

test('waiting-for-approval state shows the pending tool and clears on decision', () => {
  const p = new TaskProgress({ cwd: '/p' });
  p.setApproval({ toolName: 'Bash', reason: 'destructive or irreversible shell command' });
  assert.equal(p.state, STATE.WAITING_APPROVAL);
  assert.match(p.render(), /🔐 等待授权：Bash/);

  p.clearApproval('allow');
  assert.equal(p.state, STATE.RUNNING);
  assert.equal(p.approval, null);
});

test('throttled editor coalesces bursts into a single write', async () => {
  let now = 0;
  const timers = [];
  const written = [];
  const editor = new ThrottledEditor({
    intervalMs: 1000,
    write: async (t) => { written.push(t); },
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });

  await editor.submit('a');
  assert.deepEqual(written, ['a'], 'first submit writes immediately');

  await editor.submit('b');
  await editor.submit('c');
  await editor.submit('d');
  assert.deepEqual(written, ['a'], 'bursts are held by the throttle');

  now = 1000;
  await timers[0].fn();
  assert.deepEqual(written, ['a', 'd'], 'only the newest frame is written');
});

test('flushNow bypasses the throttle for terminal states', async () => {
  const written = [];
  const editor = new ThrottledEditor({ intervalMs: 10_000, write: async (t) => { written.push(t); } });
  await editor.submit('mid');
  await editor.flushNow('final');
  assert.deepEqual(written, ['mid', 'final']);
  editor.dispose();
});
