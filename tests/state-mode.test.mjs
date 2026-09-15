import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.mjs';
import { SessionManager } from '../src/session-manager.mjs';

function fakeSession(file) {
  const state = new StateStore(file);
  const permissions = { getLevel: () => 'standard', syncSession() {}, reset() {} };
  const approvals = { cancelForSession() {}, clearSessionAllows() {} };
  return { state, sessions: new SessionManager({ state, permissionManager: permissions, approvalManager: approvals, defaultCwd: 'C:/repo' }) };
}

test('new and legacy channels default to Chat + AUTO without destroying work settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ channels: { legacy: { cwd: 'D:/old', executorId: 'workbuddy', providerId: 'workbuddy-free', model: 'old', sessionId: 's1' } } }));
  const { sessions } = fakeSession(file);
  const legacy = sessions.get('legacy');
  assert.equal(legacy.mode, 'chat');
  assert.equal(legacy.chatProviderId, 'auto');
  assert.equal(legacy.cwd, 'D:/old');
  assert.equal(legacy.sessionId, 's1');
});

test('a UTF-8 BOM in the state file does not silently reset every channel to Chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-state-'));
  const file = path.join(dir, 'state.json');
  // Windows PowerShell `Set-Content -Encoding UTF8` writes a BOM; before the fix
  // JSON.parse threw and the store fell back to empty state.
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({
    channels: { c1: { mode: 'work', executorId: 'claude', providerId: 'opencode-go', model: 'deepseek-v4.1-flash', cwd: 'D:/repo' } },
  }));
  const { sessions } = fakeSession(file);
  const value = sessions.get('c1');
  assert.equal(value.mode, 'work');
  assert.equal(value.executorId, 'claude');
  assert.equal(value.providerId, 'opencode-go');
});

test('mode and chat selection persist independently from Agent selection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-state-'));
  const file = path.join(dir, 'state.json');
  const { sessions } = fakeSession(file);
  sessions.setMode('c1', 'work');
  sessions.setChatSelection('c1', { providerId: 'opencode-go', model: 'glm-5.3-flash' });
  const value = sessions.get('c1');
  assert.equal(value.mode, 'work');
  assert.equal(value.chatProviderId, 'opencode-go');
  assert.equal(value.chatModel, 'glm-5.3-flash');
  assert.equal(value.providerId, 'workbuddy-free');
});
