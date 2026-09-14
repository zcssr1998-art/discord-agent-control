import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager } from '../src/approval-manager.mjs';

test('allow-session persists by session and rule', async () => {
  const m = new ApprovalManager({ timeoutMs: 2000 });
  let id;
  m.setPresenter((req) => { id = req.id; setTimeout(() => m.resolve(id, 'allow-session'), 5); });
  const first = await m.request({ sessionId: 's1', ruleKey: 'bash-network' });
  assert.equal(first.decision, 'allow');
  const second = await m.request({ sessionId: 's1', ruleKey: 'bash-network' });
  assert.equal(second.reason, 'approved for session');
});

test('no presenter fails closed', async () => {
  const m = new ApprovalManager({ timeoutMs: 10 });
  const r = await m.request({ sessionId: 's1', ruleKey: 'x' });
  assert.equal(r.decision, 'deny');
});
