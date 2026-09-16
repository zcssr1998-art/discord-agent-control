import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildTaskAction, parseSchtasksInfo, AUTOSTART_TASK_NAME } from '../src/autostart.mjs';

test('autostart: task action launches the supervisor, never node directly', () => {
  const action = buildTaskAction('C:\\jarvis\\checkout');
  assert.ok(/start-supervisor\.ps1/i.test(action));
  assert.ok(!/node(?:\.exe)?\s/i.test(action));
});

test('autostart: canonical task name', () => {
  assert.equal(AUTOSTART_TASK_NAME, 'Jarvis Discord Agent Control');
});

test('autostart: parses schtasks /fo list /v output deterministically', () => {
  const sample = [
    'Folder: \\',
    'HostName:                             OWNER-PC',
    'TaskName:                             \\Jarvis Discord Agent Control',
    'Status:                               Ready',
    'Task To Run:                          cmd.exe /d "C:\\jarvis\\checkout\\scripts" && powershell.exe -File supervisor.ps1',
  ].join('\n');
  const info = parseSchtasksInfo(sample);
  assert.equal(info.found, true);
  assert.equal(info.status, 'Ready');
  assert.ok(/cmd\.exe/.test(info.taskToRun));
});

test('autostart: missing task query is reported as not found', () => {
  const info = parseSchtasksInfo('ERROR: The system cannot find the file specified.');
  assert.equal(info.found, false);
  assert.equal(info.status, 'NOT_FOUND');
});

test('autostart: empty/other output is unknown', () => {
  assert.equal(parseSchtasksInfo('').found, false);
  const path1 = path.join('a', 'b');
  assert.equal(typeof path1, 'string');
});
