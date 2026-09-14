import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSpawnPlan, quoteWindowsArg } from '../src/claude-runner.mjs';

// Regression: `shell: true` makes Node join command + args with spaces without
// quoting, so a command path containing a space used to be split and the child
// died with "not recognized as an internal or external command".

test('windows: spaced .cmd path is quoted when using a shell', () => {
  const plan = buildSpawnPlan('C:\\Program Files\\Claude\\claude.cmd', ['-p'], { platform: 'win32' });
  assert.equal(plan.shell, true);
  assert.equal(plan.file, '"C:\\Program Files\\Claude\\claude.cmd"');
  assert.deepEqual(plan.args, ['-p']);
});

// Regression: `shell: true` also means Node does NOT quote arguments, so a prompt
// containing spaces used to arrive at the child truncated to its first word.
test('windows: arguments containing spaces are quoted, not split', () => {
  const plan = buildSpawnPlan('claude', ['-p', 'Read the file package.json'], { platform: 'win32' });
  assert.deepEqual(plan.args, ['-p', '"Read the file package.json"']);
});

test('quoteWindowsArg follows the CommandLineToArgvW escaping rules', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('has space'), '"has space"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg('C:\\a b\\c'), '"C:\\a b\\c"');
  // A trailing backslash must be doubled so it does not escape the closing quote.
  assert.equal(quoteWindowsArg('ends with space \\'), '"ends with space \\\\"');
  // cmd metacharacters force quoting even without a space.
  assert.equal(quoteWindowsArg('a&b'), '"a&b"');
  assert.equal(quoteWindowsArg('a|b'), '"a|b"');
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
