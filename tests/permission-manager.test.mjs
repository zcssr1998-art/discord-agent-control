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

test('a running session sees a permission change on its next tool call', async () => {
  const permissions = new PermissionManager();
  permissions.syncSession('s1', 'c1');
  assert.equal((await permissions.classify({ sessionId: 's1', toolName: 'PowerShell', toolInput: { command: 'echo ok' }, cwd })).decision, 'ask');
  permissions.switchLevel('c1', LEVEL.RELAXED);
  assert.equal((await permissions.classify({ sessionId: 's1', toolName: 'PowerShell', toolInput: { command: 'echo ok' }, cwd })).decision, 'allow');
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

test('an explicit tier persists across session/workspace changes and a bridge restart', () => {
  const persisted = new Map();
  const make = () => new PermissionManager({
    initialLevels: Object.fromEntries(persisted),
    onChange: (channelId, level) => persisted.set(channelId, level),
  });

  const permissions = make();
  permissions.syncSession('s1', 'c1');
  permissions.confirmFull('c1');
  assert.equal(permissions.getLevel('c1'), LEVEL.FULL);

  // A workspace/model/session change clears session bookkeeping, not the tier.
  permissions.reset('c1', 'cwd');
  assert.equal(permissions.getLevel('c1'), LEVEL.FULL, 'FULL must survive a workspace/session change');
  assert.equal(permissions.getLevelBySession('s1'), LEVEL.STANDARD, 'stale session bookkeeping is cleared');
  permissions.syncSession('s2', 'c1');
  assert.equal(permissions.getLevelBySession('s2'), LEVEL.FULL, 'a new session inherits the persisted tier');

  // A "bridge restart" (fresh manager from persisted state) still sees FULL.
  assert.equal(make().getLevel('c1'), LEVEL.FULL);
  // A channel the owner never configured migrates safely to STANDARD.
  assert.equal(make().getLevel('c-new'), LEVEL.STANDARD);
});
