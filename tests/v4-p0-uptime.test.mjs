// P0 uptime hardening regression (deterministic, model-free, no network).
//
// Covers only the production Discord shell recovery surface:
// crash-containment contract (static), stale-proxy direct fallback,
// Gateway lifecycle observation, autostart truthfulness (locale + checkout),
// data-dir test isolation, and credential reseeding without file churn.
// It never touches FAST/3MODEL/HEAVY_LOCAL/V3/V4 routing behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureDiscordProxy, clearDiscordProxy, isProxyActive, proxyFallbackInfo, activeProxyUrl,
} from '../src/discord-proxy.mjs';
import { isNetworkError, isIntentError, explainDiscordLoginError } from '../src/discord-errors.mjs';
import {
  buildTaskAction, parseSchtasksInfo, parseScheduledTaskJson, isTaskActionForRoot,
} from '../src/autostart.mjs';
import { resolveDataDir } from '../src/paths.mjs';
import { CredentialStore } from '../src/credential-store.mjs';

test('P0: network failures are distinguished from auth failures', () => {
  assert.equal(isNetworkError('connect ECONNREFUSED 127.0.0.1:7890'), true);
  assert.equal(isNetworkError('fetch failed'), true);
  assert.equal(isNetworkError('socket hang up'), true);
  assert.equal(isNetworkError('TimeoutError: chat provider timed out'), true);
  assert.equal(isNetworkError('An invalid token was provided'), false);
  assert.equal(isNetworkError('Used disallowed intents'), false);
  assert.equal(isIntentError('Used disallowed intents'), true);
  assert.equal(isIntentError('connect ECONNREFUSED'), false);
  assert.match(explainDiscordLoginError('connect ECONNREFUSED'), /proxy/i);
});

test('P0: stale proxy falls back to direct and is reported truthfully', () => {
  clearDiscordProxy('test setup');
  assert.equal(isProxyActive(), false);
  assert.equal(activeProxyUrl(), null);
  configureDiscordProxy('http://127.0.0.1:9');
  assert.equal(isProxyActive(), true);
  assert.equal(activeProxyUrl(), 'http://127.0.0.1:9');
  const previous = clearDiscordProxy('test stale proxy');
  assert.equal(previous, 'http://127.0.0.1:9');
  assert.equal(isProxyActive(), false);
  const info = proxyFallbackInfo();
  assert.equal(info.previousProxyUrl, 'http://127.0.0.1:9');
  assert.match(info.reason, /test stale proxy/);
  assert.ok(info.at);
  // Leave the process direct for the rest of the suite.
  clearDiscordProxy('test teardown');
});

test('P0: autostart action still launches the supervisor, never node', () => {
  const action = buildTaskAction('C:\\jarvis\\checkout');
  assert.ok(/start-supervisor\.ps1/i.test(action));
  assert.ok(!/node(?:\.exe)?\s/i.test(action));
});

test('P0: scheduled-task JSON parses locale-independently', () => {
  const raw = JSON.stringify({
    TaskName: 'Jarvis Discord Agent Control',
    State: 'Ready',
    Actions: [{ Execute: 'powershell.exe', Arguments: '-File "C:\\j\\scripts\\start-supervisor.ps1"' }],
  });
  const info = parseScheduledTaskJson(raw);
  assert.equal(info.found, true);
  assert.equal(info.status, 'Ready');
  assert.ok(/start-supervisor\.ps1/.test(info.taskToRun));
  assert.equal(parseScheduledTaskJson('not json').found, false);
  // TaskState serialises as an enum integer over ConvertTo-Json.
  const running = parseScheduledTaskJson(JSON.stringify({ TaskName: 't', State: 4, Actions: [] }));
  assert.equal(running.status, 'Running');
  const disabled = parseScheduledTaskJson(JSON.stringify({ TaskName: 't', State: 1, Actions: [] }));
  assert.equal(disabled.status, 'Disabled');
});

test('P0: localised schtasks output is still recognised as found', () => {
  // Chinese Windows localises the key names; the action line still names the
  // supervisor script. This must never be misreported as "not installed".
  const localized = [
    '文件夹: \\',
    '任务名:  \\Jarvis Discord Agent Control',
    '要运行的任务: powershell.exe -NoProfile -File "C:\\j\\scripts\\start-supervisor.ps1"',
  ].join('\n');
  const info = parseSchtasksInfo(localized);
  assert.equal(info.found, true);
  assert.ok(/start-supervisor\.ps1/.test(info.taskToRun));
});

test('P0: task action is matched to the live checkout', () => {
  const action = 'powershell.exe -NoProfile -File "C:\\jarvis\\checkout\\scripts\\start-supervisor.ps1"';
  assert.equal(isTaskActionForRoot(action, 'C:\\jarvis\\checkout'), true);
  assert.equal(isTaskActionForRoot(action, 'c:/jarvis/checkout'), true);
  assert.equal(isTaskActionForRoot(action, 'D:\\elsewhere'), false);
  assert.equal(isTaskActionForRoot('node src/index.mjs', 'C:\\jarvis\\checkout'), false);
  assert.equal(isTaskActionForRoot(null, 'C:\\jarvis\\checkout'), false);
});

test('P0: data-dir isolation keeps tests off the owner data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-data-'));
  try {
    assert.equal(resolveDataDir('/repo', {}), path.join('/repo', 'data'));
    assert.equal(resolveDataDir('/repo', { JARVIS_DATA_DIR: tmp }), path.resolve(tmp));
    assert.equal(resolveDataDir('/repo', { JARVIS_DATA_DIR: '  ' }), path.join('/repo', 'data'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P0: reseeding the identical credential does not dirty the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p0-creds-'));
  try {
    const file = path.join(dir, 'credentials.json');
    const store = new CredentialStore(file);
    store.set('provider:x', 'secret-value-123');
    const mtime = fs.statSync(file).mtimeMs;
    store.set('provider:x', 'secret-value-123');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    store.set('provider:x', 'different-secret-456');
    assert.ok(fs.statSync(file).mtimeMs >= mtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0: crash containment must exit so the supervisor restarts', () => {
  const src = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const fatal = src.slice(src.indexOf('const fatalShutdown'));
  assert.ok(/process\.exit\(1\)/.test(fatal), 'fatalShutdown must exit(1) instead of lingering with a destroyed client');
  assert.ok(/guard\.release\(\)/.test(fatal), 'fatalShutdown must release the instance lock before exiting');
  assert.ok(/forceExit|setTimeout/.test(fatal), 'fatalShutdown must force the exit even if teardown hangs');
});

test('P0: Gateway lifecycle is observed without touching routing', () => {
  const src = fs.readFileSync(new URL('../src/discord-ui.mjs', import.meta.url), 'utf8');
  for (const event of ['shardDisconnect', 'shardReconnecting', 'shardResume', 'shardError', "'ready'", "'error'", "'invalidated'"]) {
    assert.ok(src.includes(event), `discord-ui must observe ${event}`);
  }
  assert.ok(src.includes('discordConnectionSummary'), 'doctor/status must render the observed connection');
  assert.ok(src.includes('#loginWithProxyFallback'), 'login must retry direct once on a stale proxy');
});
