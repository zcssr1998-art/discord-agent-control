import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookServer } from '../src/hook-server.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('hook server auto-allows read and asks risky bash', async (t) => {
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  approvals.setPresenter((req) => setTimeout(() => approvals.resolve(req.id, 'allow-once'), 5));
  const config = {
    defaultCwd: process.cwd(),
    autoAllowWorkspaceWrites: true,
    autoAllowTestCommands: true,
  };
  const server = createHookServer({ config, approvalManager: approvals, secret: 'test-secret' });
  const port = await listen(server);
  t.after(() => server.close());

  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' }, body: JSON.stringify(body),
    });
    return await r.json();
  };

  const read = await call({ tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd: process.cwd(), session_id: 's' });
  assert.equal(read.hookSpecificOutput.permissionDecision, 'allow');

  const push = await call({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: process.cwd(), session_id: 's' });
  assert.equal(push.hookSpecificOutput.permissionDecision, 'allow');
});

test('hook server denies a risky call when the owner denies it', async (t) => {
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  approvals.setPresenter((req) => setTimeout(() => approvals.resolve(req.id, 'deny'), 5));
  const config = { defaultCwd: process.cwd(), autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
  const server = createHookServer({ config, approvalManager: approvals, secret: 'test-secret' });
  const port = await listen(server);
  t.after(() => server.close());

  const r = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' }, cwd: process.cwd(), session_id: 's' }),
  });
  const body = await r.json();
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /denied from Discord/);
});

test('hook server fails closed on a bad secret and never blocks a read', async (t) => {
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  approvals.setPresenter(() => { throw new Error('should not be reached for reads'); });
  const config = { defaultCwd: process.cwd(), autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
  const server = createHookServer({ config, approvalManager: approvals, secret: 'test-secret' });
  const port = await listen(server);
  t.after(() => server.close());

  const bad = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    body: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }),
  });
  assert.equal((await bad.json()).hookSpecificOutput.permissionDecision, 'deny');

  // Read-only tool calls must be answered without ever touching the approval UI.
  const read = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
    body: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }),
  });
  assert.equal((await read.json()).hookSpecificOutput.permissionDecision, 'allow');
});

test('hook server uses the shared PermissionManager for every decision', async (t) => {
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  let prompts = 0;
  approvals.setPresenter((req) => { prompts += 1; setTimeout(() => approvals.resolve(req.id, 'deny'), 5); });
  const permissions = new PermissionManager();
  permissions.syncSession('s', 'c');
  permissions.switchLevel('c', 'strict');
  const config = { defaultCwd: process.cwd() };
  const server = createHookServer({ config, approvalManager: approvals, permissionManager: permissions, secret: 'test-secret' });
  const port = await listen(server);
  t.after(() => server.close());
  const call = async (tool_name, tool_input) => {
    const response = await fetch(`http://127.0.0.1:${port}/pre-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ tool_name, tool_input, cwd: process.cwd(), session_id: 's' }),
    });
    return (await response.json()).hookSpecificOutput.permissionDecision;
  };

  assert.equal(await call('Write', { file_path: 'src/x.mjs' }), 'deny');
  assert.equal(prompts, 1);
  permissions.switchLevel('c', 'relaxed');
  assert.equal(await call('PowerShell', { command: 'Write-Output ok' }), 'allow');
  assert.equal(prompts, 1);
  permissions.confirmFull('c');
  assert.equal(await call('Bash', { command: 'rm -rf build' }), 'allow');
  assert.equal(await call('Bash', { command: 'git add .env' }), 'deny');
  assert.equal(prompts, 1, 'hard secret protection is never sent through a bypass prompt');
});

