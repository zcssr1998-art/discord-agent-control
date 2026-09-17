import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableStore, SCHEMA_VERSION } from '../src/durable-store.mjs';

function tmpDb(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file: path.join(root, 'jarvis.db'), root };
}

test('durable store: open is idempotent and sets schema version + WAL', (t) => {
  const { file } = tmpDb(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  assert.equal(store.status().open, true);
  assert.equal(store.status().schemaVersion, SCHEMA_VERSION);
  store.open(); // second open is a no-op
  store.close();
  assert.equal(store.status().open, false);
});

test('durable store: run start -> finish records final state and duration', (t) => {
  const { file } = tmpDb(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  store.runStart({ runId: 'r1', channel: 'c1', channelId: 'c1', workspace: 'W', title: 'T', providerId: 'p', model: 'm' });
  store.runSession('r1', 'sess-1');
  store.runFinish('r1', { state: 'DONE', durationMs: 4300, costUsd: 0.123, tests: '12/12' });
  const row = store.db.prepare('SELECT * FROM runs WHERE run_id = ?').get('r1');
  assert.equal(row.state, 'DONE');
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.duration_ms, 4300);
  assert.equal(row.tests, '12/12');
  assert.ok(row.finished_at);
  // long error messages are clipped
  store.runStart({ runId: 'r2', channelId: 'c1' });
  store.runFinish('r2', { state: 'FAILED', errorMessage: 'x'.repeat(4000) });
  const row2 = store.db.prepare('SELECT * FROM runs WHERE run_id = ?').get('r2');
  assert.equal(row2.error_message.length, 500);
  store.close();
});

test('durable store: stale RUNNING rows become INTERRUPTED on reopen (no auto-resume)', (t) => {
  const { file } = tmpDb(t);
  const first = new DurableStore({ file, logger: null });
  first.open();
  first.runStart({ runId: 'alive', channelId: 'c1' });
  first.runStart({ runId: 'dead', channelId: 'c2' });
  first.runFinish('alive', { state: 'DONE' });
  // The bridge crashed without finishing: 'dead' stays RUNNING on disk.
  first.db.close();
  first.db = null;
  // Re-open: startup recovery must mark it INTERRUPTED, never resume it.
  const second = new DurableStore({ file, logger: null });
  second.open();
  assert.equal(second.db.prepare('SELECT state FROM runs WHERE run_id = ?').get('dead').state, 'INTERRUPTED');
  assert.equal(second.db.prepare('SELECT state FROM runs WHERE run_id = ?').get('alive').state, 'DONE');
  second.close();
});

test('durable store: follow-up queue lifecycle is auditable', (t) => {
  const { file } = tmpDb(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  store.followUpAdd({ id: 'f1', channelId: 'c1', position: 1, prompt: 'p' });
  store.followUpAdd({ id: 'f2', channelId: 'c1', position: 2, prompt: 'q' });
  assert.equal(store.status().pendingFollowups, 2);
  store.followUpsClear('c1', { state: 'CANCELLED' });
  assert.equal(store.status().pendingFollowups, 0);
  const rows = store.db.prepare('SELECT id, state FROM queued_followups ORDER BY id').all().map((r) => ({ id: r.id, state: r.state }));
  assert.deepEqual(rows, [{ id: 'f1', state: 'CANCELLED' }, { id: 'f2', state: 'CANCELLED' }]);
  store.followUpAdd({ id: 'f3', channelId: 'c2', position: 1, prompt: 'r' });
  store.followUpRemove('f3', { state: 'EXECUTED' });
  assert.equal(store.status().pendingFollowups, 0);
  store.close();
});

test('durable store: status reports pending follow-ups after restart marker', (t) => {
  const { file } = tmpDb(t);
  const store = new DurableStore({ file, logger: null });
  store.open();
  const active = store.pendingActiveRuns();
  assert.deepEqual(active, []);
  store.runStart({ runId: 'z', channelId: 'c9' });
  assert.equal(store.pendingActiveRuns().length, 1);
  store.close();
});
