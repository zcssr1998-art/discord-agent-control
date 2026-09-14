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

test('deny really denies and is reported to the settled handler', async () => {
  const m = new ApprovalManager({ timeoutMs: 2000 });
  const settled = [];
  m.setSettledHandler((e) => settled.push(e));
  m.setPresenter((req) => setTimeout(() => m.resolve(req.id, 'deny'), 5));
  const r = await m.request({ sessionId: 's1', ruleKey: 'bash-destructive' });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'denied from Discord');
  assert.equal(settled.length, 1);
});

test('allow-session is scoped to one session and one rule key', async () => {
  const m = new ApprovalManager({ timeoutMs: 2000 });
  m.setPresenter((req) => setTimeout(() => m.resolve(req.id, 'allow-session'), 5));
  await m.request({ sessionId: 's1', ruleKey: 'bash-network' });
  assert.equal(m.isSessionAllowed('s1', 'bash-network'), true);
  assert.equal(m.isSessionAllowed('s1', 'bash-destructive'), false, 'other rule keys stay gated');
  assert.equal(m.isSessionAllowed('s2', 'bash-network'), false, 'other sessions stay gated');
});

test('timeout denies instead of hanging the agent forever', async () => {
  const m = new ApprovalManager({ timeoutMs: 20 });
  m.setPresenter(() => { /* never resolves */ });
  const r = await m.request({ sessionId: 's1', ruleKey: 'x' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /timed out/);
});

test('stop/reset can cancel every pending approval for a session', async () => {
  const m = new ApprovalManager({ timeoutMs: 5000 });
  m.setPresenter(() => { /* hold */ });
  const p1 = m.request({ sessionId: 's1', ruleKey: 'a' });
  const p2 = m.request({ sessionId: 's2', ruleKey: 'a' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.pending.size, 2);

  const cancelled = m.cancelForSession('s1', 'stopped from Discord');
  assert.equal(cancelled, 1);
  assert.equal((await p1).decision, 'deny');
  assert.equal(m.pending.size, 1);
  m.cancelForSession(null, 'cleanup');
  assert.equal((await p2).decision, 'deny');
});

test('clearSessionAllows re-arms the gate for a reset session', async () => {
  const m = new ApprovalManager({ timeoutMs: 1000 });
  m.allowForSession('s1', 'bash-network');
  m.allowForSession('s2', 'bash-network');
  assert.equal(m.clearSessionAllows('s1'), 1);
  assert.equal(m.isSessionAllowed('s1', 'bash-network'), false);
  assert.equal(m.isSessionAllowed('s2', 'bash-network'), true);
});

