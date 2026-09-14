import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSpawnPlan } from '../src/claude-runner.mjs';

// Regression: `shell: true` makes Node join command + args with spaces without
// quoting, so a command path containing a space used to be split and the child
// died with "not recognized as an internal or external command".

test('windows: spaced .cmd path is quoted when using a shell', () => {
  const plan = buildSpawnPlan('C:\\Program Files\\Claude\\claude.cmd', ['-p'], { platform: 'win32' });
  assert.equal(plan.shell, true);
  assert.equal(plan.file, '"C:\\Program Files\\Claude\\claude.cmd"');
  assert.deepEqual(plan.args, ['-p']);
});

test('windows: bare command still goes through the shell unquoted-safe', () => {
  const plan = buildSpawnPlan('claude', ['-p'], { platform: 'win32' });
  assert.equal(plan.shell, true);
  assert.equal(plan.file, '"claude"');
});

test('windows: pre-quoted command is not double quoted', () => {
  const plan = buildSpawnPlan('"C:\\Program Files\\Claude\\claude.cmd"', [], { platform: 'win32' });
  assert.equal(plan.file, '"C:\\Program Files\\Claude\\claude.cmd"');
});

test('node scripts are launched via the node binary without a shell', () => {
  const script = path.join('C:', 'some dir', 'fake-claude.mjs');
  const plan = buildSpawnPlan(script, ['-p'], { platform: 'win32', execPath: 'C:\\node\\node.exe' });
  assert.equal(plan.shell, false);
  assert.equal(plan.file, 'C:\\node\\node.exe');
  assert.equal(plan.args[0], path.resolve(script));
  assert.deepEqual(plan.args.slice(1), ['-p']);
});

test('posix spawns directly without a shell', () => {
  const plan = buildSpawnPlan('/usr/local/bin/claude', ['-p'], { platform: 'linux' });
  assert.equal(plan.shell, false);
  assert.equal(plan.file, '/usr/local/bin/claude');
});

test('empty command is rejected instead of spawning nonsense', () => {
  assert.throws(() => buildSpawnPlan('   ', [], { platform: 'win32' }), /empty/);
});
