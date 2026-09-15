import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceScheduler, canonicalKey } from '../src/workspace-scheduler.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const WORKSPACE_A = path.join(os.tmpdir(), 'jarvis-ws-a');
const WORKSPACE_B = path.join(os.tmpdir(), 'jarvis-ws-b');

test('same canonical workspace never runs two callbacks concurrently', async () => {
  const scheduler = new WorkspaceScheduler();
  let active = 0;
  let maxActive = 0;
  const run = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await tick(10);
    active -= 1;
  };

  const first = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'a', run });
  const second = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'a2', run });
  await Promise.all([first.done, second.done]);

  assert.equal(maxActive, 1, 'the workspace lock must serialise callbacks');
});

test('case and trailing-separator forms collide on Windows semantics', (t) => {
  const base = WORKSPACE_A;
  const variants = [
    base,
    `${base}${path.sep}`,
    process.platform === 'win32' ? base.toUpperCase() : base,
  ];
  const keys = variants.map((value) => canonicalKey(value));
  assert.equal(new Set(keys).size, 1, `expected one canonical key, got ${JSON.stringify(keys)}`);

  if (process.platform === 'win32') {
    const scheduler = new WorkspaceScheduler();
    assert.equal(
      scheduler.canonicalKey('C:\\Some\\Repo\\'),
      scheduler.canonicalKey('c:\\some\\repo'),
      'D:\\Repo and a lower-case trailing-separator form must collide',
    );
  } else {
    t.diagnostic('case-insensitive collision is a Windows-only guarantee');
  }
});

test('different workspaces run concurrently', async () => {
  const scheduler = new WorkspaceScheduler();
  const gate = deferred();
  let active = 0;
  let maxActive = 0;
  const run = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  };

  const a = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'a', run });
  const b = scheduler.submit({ workspace: WORKSPACE_B, channelId: 'b', run });
  await tick(5);
  assert.equal(maxActive, 2, 'separate workspaces must not block each other');

  gate.resolve();
  await Promise.all([a.done, b.done]);
});

test('same-workspace tasks run in FIFO order', async () => {
  const scheduler = new WorkspaceScheduler();
  const order = [];
  const run = (id) => async () => { order.push(id); await tick(1); };

  const first = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'one', run: run(1) });
  const second = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'two', run: run(2) });
  const third = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'three', run: run(3) });
  await Promise.all([first.done, second.done, third.done]);

  assert.deepEqual(order, [1, 2, 3]);
});

test('success releases the workspace and starts the next queued item exactly once', async () => {
  const scheduler = new WorkspaceScheduler();
  const starts = [];
  const first = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'one', run: async () => { starts.push('one'); } });
  const second = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'two', run: async () => { starts.push('two'); } });
  await Promise.all([first.done, second.done]);

  assert.deepEqual(starts, ['one', 'two']);
  assert.deepEqual(scheduler.snapshot(WORKSPACE_A).queued, []);
  assert.equal(scheduler.snapshot(WORKSPACE_A).active, null);
});

test('failure still releases the workspace and starts the next item', async () => {
  const scheduler = new WorkspaceScheduler();
  const starts = [];
  const first = scheduler.submit({
    workspace: WORKSPACE_A,
    channelId: 'one',
    run: async () => { starts.push('one'); throw new Error('boom'); },
  });
  const second = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'two', run: async () => { starts.push('two'); } });

  await assert.rejects(first.done, /boom/);
  await second.done;
  assert.deepEqual(starts, ['one', 'two']);
  assert.equal(scheduler.stateFor('two').state, 'idle', 'the queue must drain after a failure');
});

test('an active task holds the workspace until its stop path actually finishes', async () => {
  const scheduler = new WorkspaceScheduler();
  const stop = deferred();
  const events = [];
  const active = scheduler.submit({
    workspace: WORKSPACE_A,
    channelId: 'active',
    run: async () => { events.push('active-start'); await stop.promise; events.push('active-stopped'); },
  });
  const next = scheduler.submit({
    workspace: WORKSPACE_A,
    channelId: 'next',
    run: async () => { events.push('next-start'); },
  });

  await tick(5);
  assert.equal(scheduler.stateFor('active').state, 'running');
  assert.equal(scheduler.stateFor('next').state, 'queued');
  assert.deepEqual(events, ['active-start'], 'the queued item must not start while active is stopping');

  stop.resolve();
  await Promise.all([active.done, next.done]);
  assert.deepEqual(events, ['active-start', 'active-stopped', 'next-start']);
});

test('cancelling a queued request removes only that request and never starts it', async () => {
  const scheduler = new WorkspaceScheduler();
  const release = deferred();
  const started = [];
  const active = scheduler.submit({
    workspace: WORKSPACE_A, channelId: 'active',
    run: async () => { started.push('active'); await release.promise; },
  });
  const victim = scheduler.submit({
    workspace: WORKSPACE_A, channelId: 'victim',
    run: async () => { started.push('victim'); },
  });
  const keeper = scheduler.submit({
    workspace: WORKSPACE_A, channelId: 'keeper',
    run: async () => { started.push('keeper'); },
  });

  await tick(5);
  const removed = scheduler.cancelQueued('victim');
  assert.equal(removed, victim);
  assert.equal(victim.cancelled, true);
  assert.equal(scheduler.stateFor('victim').state, 'idle');
  assert.equal(scheduler.stateFor('keeper').position, 1, 'the remaining queue is renumbered');

  release.resolve();
  await Promise.all([active.done, keeper.done, victim.done]);
  assert.deepEqual(started, ['active', 'keeper'], 'the cancelled item must never run');
});

test('a queued request never invokes its run callback before the lock is acquired', async () => {
  const scheduler = new WorkspaceScheduler();
  const release = deferred();
  const runs = [];
  const active = scheduler.submit({
    workspace: WORKSPACE_A, channelId: 'active',
    run: async () => { runs.push('active'); await release.promise; },
  });
  const queued = scheduler.submit({
    workspace: WORKSPACE_A, channelId: 'queued',
    run: async () => { runs.push('queued'); },
  });

  await tick(5);
  assert.deepEqual(runs, ['active'], 'no queued runner may start before the workspace is free');

  release.resolve();
  await Promise.all([active.done, queued.done]);
  assert.deepEqual(runs, ['active', 'queued']);
});

test('snapshot reports active and queued work per workspace', async () => {
  const scheduler = new WorkspaceScheduler();
  const release = deferred();
  const releaseB = deferred();
  const active = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'a', run: async () => { await release.promise; } });
  const queued = scheduler.submit({ workspace: WORKSPACE_A, channelId: 'b', run: async () => {} });
  const other = scheduler.submit({ workspace: WORKSPACE_B, channelId: 'c', run: async () => { await releaseB.promise; } });

  await tick(5);
  const snapshot = scheduler.snapshot(WORKSPACE_A);
  assert.equal(snapshot.active.channelId, 'a');
  assert.deepEqual(snapshot.queued.map((item) => item.channelId), ['b']);
  assert.equal(snapshot.queueLength, 1);
  assert.equal(scheduler.snapshot().length, 2, 'both active workspaces are present');

  release.resolve();
  await Promise.all([active.done, queued.done]);
  releaseB.resolve();
  await other.done;
});
