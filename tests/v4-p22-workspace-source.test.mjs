import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableStore } from '../src/durable-store.mjs';

test('effective workspace follows the most recent real run, not a historical default', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DurableStore({ file: path.join(dir, 'jarvis.db'), logger: null });
  store.open();
  store.runStart({ runId: 'r1', channelId: 'c1', workspace: 'D:\\real\\project', model: 'deepseek-v4.1-flash', providerId: 'opencode-go' });
  store.runFinish('r1', { state: 'DONE' });
  const latest = store.latestRun();
  assert.equal(latest.workspace, 'D:\\real\\project');
  assert.equal(latest.provider_id, 'opencode-go');
  store.close();
});
