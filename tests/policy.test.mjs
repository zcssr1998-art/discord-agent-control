import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyToolCall } from '../src/policy.mjs';

const config = { autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const p = (...parts) => process.platform === 'win32' ? ['C:\\work\\repo', ...parts].join('\\') : ['/work/repo', ...parts].join('/');

test('read-only tools auto-allow', async () => {
  assert.equal((await classifyToolCall({ toolName: 'Read', toolInput: { file_path: p('a.txt') }, cwd, config })).decision, 'allow');
});

test('workspace write auto-allows', async () => {
  assert.equal((await classifyToolCall({ toolName: 'Edit', toolInput: { file_path: p('src','a.js') }, cwd, config })).decision, 'allow');
});

test('sensitive write asks', async () => {
  assert.equal((await classifyToolCall({ toolName: 'Write', toolInput: { file_path: p('.env') }, cwd, config })).decision, 'ask');
});

test('git push asks', async () => {
  const r = await classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git push origin main' }, cwd, config });
  assert.equal(r.decision, 'ask');
});

test('git status auto-allows', async () => {
  assert.equal((await classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git status --short' }, cwd, config })).decision, 'allow');
});

test('tests auto-allow', async () => {
  assert.equal((await classifyToolCall({ toolName: 'Bash', toolInput: { command: 'npm test' }, cwd, config })).decision, 'allow');
});

test('git add/commit are safe but push/reset --hard/clean/rebase stay gated', async () => {
  const decide = async (command) => (await classifyToolCall({ toolName: 'Bash', toolInput: { command }, cwd, config })).decision;
  assert.equal(await decide('git add -A'), 'allow');
  assert.equal(await decide('git commit -m "feat: x"'), 'allow');
  assert.equal(await decide('git checkout -b feature/x'), 'allow');
  assert.equal(await decide('git push origin main'), 'ask');
  assert.equal(await decide('git reset --hard HEAD~1'), 'ask');
  assert.equal(await decide('git clean -fd'), 'ask');
  assert.equal(await decide('git rebase main'), 'ask');
  assert.equal(await decide('git checkout -- .'), 'ask', 'discarding changes must stay gated');
});

test('a not-yet-created file deep inside the workspace is still an in-workspace write', async () => {
  // Regression guard: canonicalising a path that does not exist yet must not
  // fall back to something that looks like it lives outside the workspace.
  const deep = p('src', 'brand', 'new', 'module', 'file.mjs');
  const r = await classifyToolCall({ toolName: 'Write', toolInput: { file_path: deep }, cwd, config });
  assert.equal(r.decision, 'allow', r.reason);
});

test('a sibling directory that merely shares a prefix is outside the workspace', async () => {
  const sibling = process.platform === 'win32' ? 'C:\\work\\repo-evil\\x.js' : '/work/repo-evil/x.js';
  const r = await classifyToolCall({ toolName: 'Write', toolInput: { file_path: sibling }, cwd, config });
  assert.equal(r.decision, 'ask');
  assert.match(r.reason, /outside workspace/);
});

test('the four permission levels follow the deterministic matrix', async () => {
  const call = async (permissionLevel, toolName, toolInput) => (await classifyToolCall({ toolName, toolInput, cwd, permissionLevel })).decision;
  const write = { file_path: p('src', 'a.js') };
  const bash = (command) => ({ command });

  assert.equal(await call('strict', 'Read', { file_path: p('a.txt') }), 'allow');
  assert.equal(await call('strict', 'Write', write), 'ask');
  assert.equal(await call('strict', 'Bash', bash('git status --short')), 'allow');
  assert.equal(await call('strict', 'Bash', bash('npm test')), 'ask');
  assert.equal(await call('strict', 'Bash', bash('git commit -m x')), 'ask');

  assert.equal(await call('standard', 'Write', write), 'allow');
  assert.equal(await call('standard', 'Bash', bash('npm test')), 'allow');
  assert.equal(await call('standard', 'Bash', bash('git commit -m x')), 'allow');
  assert.equal(await call('standard', 'PowerShell', bash('Write-Output ok')), 'ask');
  assert.equal(await call('standard', 'Bash', bash('curl https://example.com')), 'ask');
  assert.equal(await call('standard', 'Bash', bash('git push origin main')), 'ask');

  assert.equal(await call('relaxed', 'PowerShell', bash('Write-Output ok')), 'allow');
  assert.equal(await call('relaxed', 'Bash', bash('curl https://example.com')), 'allow');
  assert.equal(await call('relaxed', 'Bash', bash('npm install left-pad')), 'allow');
  assert.equal(await call('relaxed', 'Bash', bash('git push origin main')), 'allow');
  assert.equal(await call('relaxed', 'Bash', bash('rm -rf build')), 'ask');
  assert.equal(await call('relaxed', 'PowerShell', bash('ssh host')), 'ask');
  assert.equal(await call('relaxed', 'PowerShell', bash('Set-ExecutionPolicy Unrestricted')), 'ask');

  assert.equal(await call('full', 'Bash', bash('rm -rf build')), 'allow');
  assert.equal(await call('full', 'PowerShell', bash('Write-Output ok')), 'allow');
  assert.equal(await call('full', 'Read', { file_path: p('.env') }), 'allow', 'FULL has no routine approval prompts for sensitive-by-name paths');
  assert.equal(await call('full', 'Write', { file_path: p('outside', 'x.ini') }), 'allow', 'FULL allows writes outside the workspace');
  assert.equal(await call('full', 'Bash', bash('git add .env')), 'deny', 'the hard secret-commit guard still applies under FULL');
  assert.equal(await call('full', 'Bash', bash('git commit -m x')), 'allow');
  assert.equal(await call('full', 'mcp__some__tool', {}), 'allow', 'unknown/MCP calls are not re-gated under FULL');
});

test('git commit is denied when staged added lines contain a literal secret', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init'], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, 'config.js'), 'const apiKey = "abcdefghijklmnopqrstuvwxyz";\n');
  spawnSync('git', ['add', 'config.js'], { cwd: dir, windowsHide: true });
  const result = await classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git commit -m x' }, cwd: dir, permissionLevel: 'full' });
  assert.equal(result.decision, 'deny');
});

test('the staged-secret scan is async and never uses a blocking git spawn', async () => {
  // The bridge runs this scan inside its own process; a synchronous git spawn
  // used to freeze Discord ACKs for up to 3s while a Work task committed.
  const source = fs.readFileSync(new URL('../src/policy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bspawnSync\b/, 'policy.mjs must not block the bridge event loop');
  const result = classifyToolCall({ toolName: 'Bash', toolInput: { command: 'git status' }, cwd, permissionLevel: 'standard' });
  assert.ok(result instanceof Promise, 'classifyToolCall must be awaitable so the event loop stays responsive');
  assert.equal((await result).decision, 'allow');
});
