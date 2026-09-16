// P2.2.1 supervisor / autostart recovery regression.
//
// Two layers:
//  - static: the production supervisor must not be finite, must launch the
//    bridge in its own console, and the installer must set Task Scheduler
//    restart-on-failure settings;
//  - real Windows process behavior: run the supervisor against an always-failing
//    fake bridge and prove it keeps retrying well past five failures instead of
//    permanently giving up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supervisorScript = path.join(root, 'scripts', 'start-supervisor.ps1');
const installScript = path.join(root, 'scripts', 'install-autostart.ps1');
const isWindows = process.platform === 'win32';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('recovery: supervisor defaults to unlimited production restarts', () => {
  const src = fs.readFileSync(supervisorScript, 'utf8');
  assert.match(src, /\[int\]\$MaxRestarts\s*=\s*0/, 'production default must be unlimited (MaxRestarts = 0)');
  assert.match(src, /production\(unlimited\)/);
  assert.ok(!/while \(\$consecutiveCrashes -lt \$MaxRestarts\)/.test(src), 'the old finite loop must be gone');
});

test('recovery: bridge runs in its own console, isolated from the supervisor', () => {
  const src = fs.readFileSync(supervisorScript, 'utf8');
  assert.ok(/-WindowStyle Hidden/.test(src), 'bridge must get its own hidden console');
  assert.ok(!/-NoNewWindow/.test(src), 'bridge must not share the supervisor console');
  assert.match(src, /bridge\.log/, 'bridge output must be redirected to logs/bridge.log');
});

test('recovery: LiteLLM is re-probed and recovered while the bridge runs', () => {
  const src = fs.readFileSync(supervisorScript, 'utf8');
  assert.match(src, /GatewayProbeSec/);
  assert.match(src, /Ensure-Gateway/);
  assert.match(src, /start-litellm\.ps1/);
});

test('recovery: installer configures Task Scheduler restart + watchdog', () => {
  const src = fs.readFileSync(installScript, 'utf8');
  assert.match(src, /-RestartCount\s+999/);
  assert.match(src, /-RestartInterval\s+\(New-TimeSpan -Minutes 1\)/);
  assert.match(src, /-ExecutionTimeLimit 0/);
  assert.match(src, /-StartWhenAvailable/);
  assert.match(src, /-MultipleInstances IgnoreNew/);
  assert.ok(/-Execute 'powershell\.exe'/.test(src), 'action must launch powershell natively');
  // Windows does not honor restart-on-failure for an externally killed process,
  // so a 1-minute repeating watchdog trigger is the reliable Level-2 recovery.
  assert.match(src, /New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(src, /-Trigger @\(\$Trigger, \$Watchdog\)/);
});

test('recovery: production supervisor keeps retrying past five failures', { skip: isWindows ? false : 'Windows-only real-process recovery smoke' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p221-'));
  const logDir = path.join(tmp, 'logs');
  const runtimeDir = path.join(tmp, 'runtime');
  const runDir = path.join(tmp, 'run');
  for (const dir of [logDir, runtimeDir, runDir]) fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(runDir, 'always-fail.mjs');
  fs.writeFileSync(probe, 'process.exit(1);\n', 'utf8');

  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisorScript,
    '-MaxRestarts', '0',
    '-InitialDelaySec', '1',
    '-MaxDelaySec', '1',
    '-SuccessWindowSec', '60',
    '-GatewayProbeSec', '3600',
    '-HeartbeatSec', '3600',
    '-Entry', probe,
    '-RunDirectory', runDir,
    '-LogDir', logDir,
    '-RuntimeDir', runtimeDir,
    '-NoGateway',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  const logFile = path.join(logDir, 'supervisor.log');
  let text = '';
  const deadline = Date.now() + 25000;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(logFile)) text = fs.readFileSync(logFile, 'utf8');
      if ((text.match(/Bridge UP: starting/g) || []).length >= 7) break;
      await sleep(250);
    }

    const starts = (text.match(/Bridge UP: starting/g) || []).length;
    assert.ok(starts >= 7, `expected more than five restarts, observed ${starts}`);
    assert.ok(!/Giving up/.test(text), 'production mode must never log "Giving up"');
    assert.match(text, /production\(unlimited\)/);
    assert.equal(child.exitCode, null, 'supervisor must still be alive after the failures');
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((resolve) => { if (child.exitCode != null) resolve(); else child.on('exit', resolve); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
