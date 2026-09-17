import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveStatus,
  isValidSha,
  shortSha,
  oneLine,
  parsePorcelain,
  UpdateStateStore,
  defaultUpdateState,
  rollbackToPreviousGood,
  UPDATE_STATUS,
  RELATION,
  RESTART_EXIT_CODE,
} from '../src/updater.mjs';
import { buildCommandPayloads, compareCommandSchema, workTaskMaxLength } from '../src/commands.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('restart exit code is the dedicated update code', () => {
  assert.equal(RESTART_EXIT_CODE, 74);
});

test('deriveStatus precedence: disabled > fetch > inflight > quarantine > diverged > up-to-date > dirty > paused > pending > available', () => {
  assert.equal(deriveStatus({ enabled: false }).status, UPDATE_STATUS.DISABLED);
  assert.equal(deriveStatus({ fetchOk: false }).status, UPDATE_STATUS.BLOCKED);
  assert.equal(deriveStatus({ inflight: true }).status, UPDATE_STATUS.UPDATING);
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, quarantinedSha: SHA_B }).status, UPDATE_STATUS.BLOCKED);
  assert.equal(deriveStatus({ relation: RELATION.DIVERGED, localSha: SHA_A, remoteSha: SHA_B }).status, UPDATE_STATUS.BLOCKED);
  assert.equal(deriveStatus({ relation: RELATION.UP_TO_DATE, localSha: SHA_A, remoteSha: SHA_A }).status, UPDATE_STATUS.UP_TO_DATE);
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, dirty: true }).status, UPDATE_STATUS.BLOCKED);
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, paused: true }).status, UPDATE_STATUS.PAUSED);
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, safe: false }).status, UPDATE_STATUS.UPDATE_PENDING);
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, safe: true }).status, UPDATE_STATUS.UPDATE_AVAILABLE);
});

test('a quarantine only applies to its exact SHA', () => {
  assert.equal(deriveStatus({ relation: RELATION.AHEAD, localSha: SHA_A, remoteSha: SHA_B, quarantinedSha: 'c'.repeat(40) }).status, UPDATE_STATUS.UPDATE_AVAILABLE);
});

test('sha helpers never invent a value', () => {
  assert.equal(isValidSha(SHA_A), true);
  assert.equal(isValidSha('short'), false);
  assert.equal(shortSha(SHA_A), 'aaaaaaa');
  assert.equal(shortSha(null), 'unknown');
});

test('oneLine redacts and bounds text', () => {
  const line = oneLine(`boom sk-abcdef1234567890\nsecond`, 100);
  assert.ok(!line.includes('sk-abcdef1234567890'));
  assert.ok(line.startsWith('boom'));
});

test('parsePorcelain reads status entries and ignores blanks', () => {
  assert.deepEqual(parsePorcelain(' M app.txt\n?? new.txt\n\n'), [
    { code: ' M', file: 'app.txt' },
    { code: '??', file: 'new.txt' },
  ]);
});

test('UpdateStateStore round-trips and survives a BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-updater-test-'));
  const file = path.join(dir, 'update-state.json');
  try {
    const store = new UpdateStateStore(file);
    store.state.paused = true;
    store.state.previousGoodSha = SHA_A;
    store.save();
    assert.equal(new UpdateStateStore(file).state.paused, true);
    fs.writeFileSync(file, `\uFEFF${fs.readFileSync(file, 'utf8')}`);
    assert.equal(new UpdateStateStore(file).state.previousGoodSha, SHA_A);
    assert.deepEqual(Object.keys(defaultUpdateState()).includes('notified'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rollbackToPreviousGood refuses without a recorded known-good SHA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-updater-rb-'));
  try {
    const result = await rollbackToPreviousGood({ root: dir, stateFile: path.join(dir, 'update-state.json') });
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetched remote /work task max_length is compared, not assumed from the local constant', () => {
  const desired = buildCommandPayloads();
  assert.equal(workTaskMaxLength(desired), 6000);
  const fetched = JSON.parse(JSON.stringify(desired));
  assert.equal(compareCommandSchema(fetched, desired).ok, true);
  fetched.find((command) => command.name === 'work').options[0].max_length = 1500;
  const mismatch = compareCommandSchema(fetched, desired);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.workTaskMaxLength, 1500);
});
