import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolCall } from '../src/policy.mjs';

const config = { autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const p = (...parts) => process.platform === 'win32' ? ['C:\\work\\repo', ...parts].join('\\') : ['/work/repo', ...parts].join('/');

test('read-only tools auto-allow', () => {
  assert.equal(classifyToolCall({ toolName: 'Read', toolInput: { file_path: p('a.txt') }, cwd, config }).decision, 'allow');
});

test('workspace write auto-allows', () => {
  assert.equal(classifyToolCall({ toolName: 'Edit', toolInput: { file_path: p('src','a.js') }, cwd, config }).decision, 'allow');
});

test('sensitive write asks', () => {
  assert.equal(classifyToolCall({ toolName: 'Write', toolInput: { file_path: p('.env') }, cwd, config }).decision, 'ask');
});

test('git push asks', () => {
  const r = classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git push origin main' }, cwd, config });
  assert.equal(r.decision, 'ask');
});

test('git status auto-allows', () => {
  assert.equal(classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git status --short' }, cwd, config }).decision, 'allow');
});

test('tests auto-allow', () => {
  assert.equal(classifyToolCall({ toolName: 'Bash', toolInput: { command: 'npm test' }, cwd, config }).decision, 'allow');
});

test('git add/commit are safe but push/reset --hard/clean/rebase stay gated', () => {
  const decide = (command) => classifyToolCall({ toolName: 'Bash', toolInput: { command }, cwd, config }).decision;
  assert.equal(decide('git add -A'), 'allow');
  assert.equal(decide('git commit -m "feat: x"'), 'allow');
  assert.equal(decide('git checkout -b feature/x'), 'allow');
  assert.equal(decide('git push origin main'), 'ask');
  assert.equal(decide('git reset --hard HEAD~1'), 'ask');
  assert.equal(decide('git clean -fd'), 'ask');
  assert.equal(decide('git rebase main'), 'ask');
  assert.equal(decide('git checkout -- .'), 'ask', 'discarding changes must stay gated');
});

test('a not-yet-created file deep inside the workspace is still an in-workspace write', () => {
  // Regression guard: canonicalising a path that does not exist yet must not
  // fall back to something that looks like it lives outside the workspace.
  const deep = p('src', 'brand', 'new', 'module', 'file.mjs');
  const r = classifyToolCall({ toolName: 'Write', toolInput: { file_path: deep }, cwd, config });
  assert.equal(r.decision, 'allow', r.reason);
});

test('a sibling directory that merely shares a prefix is outside the workspace', () => {
  const sibling = process.platform === 'win32' ? 'C:\\work\\repo-evil\\x.js' : '/work/repo-evil/x.js';
  const r = classifyToolCall({ toolName: 'Write', toolInput: { file_path: sibling }, cwd, config });
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /outside workspace/);
});
