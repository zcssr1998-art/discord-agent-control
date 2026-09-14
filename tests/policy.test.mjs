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
