import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { StateStore } from '../src/state.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';
import { buildCommandPayloads } from '../src/commands.mjs';
import { FakeDiscord } from './helpers/fake-discord.mjs';

function makePlane(application) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p226-schema-'));
  const client = { application };
  const plane = new DiscordControlPlane({
    config: {
      ownerId: 'owner-1', discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude',
      notifyOnStart: false, autoRegisterCommands: false, commandsGuildId: null, maxWorkFollowUps: 0,
    },
    state: new StateStore(path.join(dir, 'state.json')),
    approvalManager: new ApprovalManager({ timeoutMs: 0 }),
    permissionManager: new PermissionManager(),
    client,
    autoLogin: false,
  });
  return { plane, dir };
}

test('reconcileCommandSchema fetches the application schema back and passes for 6000', async () => {
  const desired = buildCommandPayloads();
  let current = JSON.parse(JSON.stringify(desired));
  const application = {
    async fetch() { return this; },
    commands: {
      async fetch() { return current; },
      async set(payloads) { current = JSON.parse(JSON.stringify(payloads)); },
    },
  };
  const { plane, dir } = makePlane(application);
  try {
    const result = await plane.reconcileCommandSchema();
    assert.equal(result.ok, true, JSON.stringify(result.mismatches));
    assert.equal(result.workTaskMaxLength, 6000);
    assert.equal(plane.commandSchema.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileCommandSchema re-syncs a stale 1500 schema and then reports PASS', async () => {
  const desired = buildCommandPayloads();
  let current = JSON.parse(JSON.stringify(desired));
  current.find((command) => command.name === 'work').options[0].max_length = 1500;
  let setCalls = 0;
  const application = {
    async fetch() { return this; },
    commands: {
      async fetch() { return current; },
      async set(payloads) { setCalls += 1; current = JSON.parse(JSON.stringify(payloads)); },
    },
  };
  const { plane, dir } = makePlane(application);
  try {
    const result = await plane.reconcileCommandSchema();
    assert.equal(setCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.workTaskMaxLength, 6000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing application is reported out-of-sync, not thrown', async () => {
  const { plane, dir } = makePlane(null);
  try {
    const result = await plane.reconcileCommandSchema();
    assert.equal(result.ok, false);
    assert.match(String(result.error || ''), /unavailable|fetch-back/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtimeActivity reports busy reasons and safe idle', () => {
  const { plane, dir } = makePlane(null);
  try {
    assert.deepEqual(plane.runtimeActivity(), { safe: true, reasons: [] });
    plane.scheduler.submit({ workspace: dir, channelId: 'chan-1', run: () => new Promise(() => {}) });
    const busy = plane.runtimeActivity();
    assert.equal(busy.safe, false);
    assert.ok(busy.reasons.some((reason) => /active Work|active task|queued/.test(reason)), JSON.stringify(busy.reasons));
    plane.scheduler.snapshot();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/update, /status and /doctor render live updater state without a model call', async () => {
  const fake = new FakeDiscord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p226-ui-'));
  const updater = {
    statusSnapshot: () => ({
      status: 'UP_TO_DATE', remote: 'origin', branch: 'main', relation: 'up_to_date',
      localSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), paused: false,
    }),
    describe: () => 'Status: UP_TO_DATE\nSource: origin/main',
    pause: () => {}, resume: async () => ({}), refresh: async () => ({}), logger: { warn: () => {} },
  };
  const plane = new DiscordControlPlane({
    config: { ownerId: fake.ownerId, discordToken: 'fake', defaultCwd: dir, claudeCommand: 'claude', notifyOnStart: false, autoRegisterCommands: false, maxWorkFollowUps: 0 },
    state: new StateStore(path.join(dir, 'state.json')),
    approvalManager: new ApprovalManager({ timeoutMs: 0 }),
    permissionManager: new PermissionManager(),
    client: fake.client,
    updater,
    autoLogin: false,
  });
  try {
    await plane.start();
    const update = await fake.command('update', { options: { action: 'status' } });
    assert.match(update.interaction.replied.content, /UP_TO_DATE/);
    const status = await fake.command('status');
    assert.match(status.interaction.replied.content, /Update: UP_TO_DATE/);
    const doctor = await fake.command('doctor');
    assert.match(doctor.interaction.replied.content, /Update: UP_TO_DATE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

