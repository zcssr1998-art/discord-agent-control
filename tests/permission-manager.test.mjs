import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager, LEVEL } from '../src/permission-manager.mjs';

const cwd = process.cwd();

test('permissions default to STANDARD and every FULL entry needs confirmation', () => {
  const permissions = new PermissionManager();
  assert.equal(permissions.getLevel('c1'), LEVEL.STANDARD);
  assert.equal(permissions.switchLevel('c1', LEVEL.FULL).needsConfirm, true);
  assert.equal(permissions.getLevel('c1'), LEVEL.STANDARD);
  permissions.confirmFull('c1');
  assert.equal(permissions.getLevel('c1'), LEVEL.FULL);
  permissions.switchLevel('c1', LEVEL.RELAXED);
  assert.equal(permissions.switchLevel('c1', LEVEL.FULL).needsConfirm, true);
});

test('a running session sees a permission change on its next tool call', () => {
  const permissions = new PermissionManager();
  permissions.syncSession('s1', 'c1');
  assert.equal(permissions.classify({ sessionId: 's1', toolName: 'PowerShell', toolInput: { command: 'echo ok' }, cwd }).decision, 'ask');
  permissions.switchLevel('c1', LEVEL.RELAXED);
  assert.equal(permissions.classify({ sessionId: 's1', toolName: 'PowerShell', toolInput: { command: 'echo ok' }, cwd }).decision, 'allow');
});

test('raising permission does not resolve an approval that is already pending', async () => {
  const permissions = new PermissionManager();
  const approvals = new ApprovalManager({ timeoutMs: 1000 });
  approvals.setPresenter(() => {});
  const pending = approvals.request({ sessionId: 's1', ruleKey: 'bash-other' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  permissions.confirmFull('c1');
  assert.equal(approvals.pending.size, 1);
  approvals.cancelForSession('s1', 'test cleanup');
  assert.equal((await pending).decision, 'deny');
});

test('reset/cwd and a bridge restart restore STANDARD', () => {
  const permissions = new PermissionManager();
  permissions.syncSession('s1', 'c1');
  permissions.confirmFull('c1');
  permissions.reset('c1', 'cwd');
  assert.equal(permissions.getLevel('c1'), LEVEL.STANDARD);
  assert.equal(permissions.getLevelBySession('s1'), LEVEL.STANDARD);
  assert.equal(new PermissionManager().getLevel('c1'), LEVEL.STANDARD);
});
