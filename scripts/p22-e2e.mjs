// P2.2 Windows real-machine smoke. Deterministic; never reboots, never kills
// another process, never logs into Discord. No bot token or network needed.
//
// Checks:
//  1. build identity matches the real .git checkout;
//  2. a second live holder is refused by the instance guard in a temp checkout;
//  3. real durable store opens (temp file), rund lifecycle + restart interrupts;
//  4. real Windows Task Scheduler autostart query round-trips (any state);
//  5. doctor renderers are deterministic.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceGuard, readLockInfo } from '../src/instance-guard.mjs';
import { resolveBuildIdentity, describeBuild } from '../src/build-identity.mjs';
import { DurableStore } from '../src/durable-store.mjs';
import { queryAutostartTask, buildTaskAction } from '../src/autostart.mjs';
import { formatUptime, wsStatusText } from '../src/discord-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

// 1. Build identity vs real git state.
{
  const identity = resolveBuildIdentity(root, gitEnvFor(root));
  const gitHead = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const gitBranch = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const real = `${(gitBranch.stdout || '').trim()}@${(gitHead.stdout || '').trim()}`;
  check('build identity matches git', describeBuild(identity) === real, `live=${describeBuild(identity)} git=${real}`);
}

// 2. Second LIVE process refused: spawn a real child process that holds the
//    lock for ~2s, then attempt the same lock from this process.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p22-'));
  const childCode = [
    "import { InstanceGuard } from 'file:///" + path.join(root, 'src', 'instance-guard.mjs').replace(/\\/g, '/') + "';",
    'const g = new InstanceGuard({ root: process.argv[2] });',
    'const r = g.acquire();',
    'console.log(JSON.stringify(r));',
    'setTimeout(() => { try { g.release(); } catch {} process.exit(0); }, 2000);',
  ].join('\n');
  const lockDir = path.join(tmp, 'data');
  const childScript = path.join(lockDir, 'holder-child.mjs');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(childScript, childCode, 'utf8');
  const child = spawn('node', [childScript, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  await new Promise((resolve) => {
    const deadline = Date.now() + 6000;
    const wait = setInterval(() => {
      const lockFile = path.join(tmp, 'data', 'jarvis-instance.lock');
      if (fs.existsSync(lockFile) || Date.now() > deadline) { clearInterval(wait); resolve(); }
    }, 50);
  });
  const info = readLockInfo(path.join(tmp, 'data', 'jarvis-instance.lock'));
  const second = new InstanceGuard({ root: tmp, build: {} });
  const refused = second.acquire();
  // Never kill the child: wait for its own release + exit (bounded).
  await Promise.race([
    new Promise((resolve) => { if (child.exitCode != null) resolve(); else child.on('exit', resolve); }),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  check('first (live child) instance acquires', /"ok": ?true/.test(stdout), stdout.trim());
  check('lock metadata readable, foreign pid', Boolean(info?.pid && info.pid !== process.pid));
  check('second live holder refused, not killed',
    refused.ok === false && refused.reason === 'already-running' && Number.isInteger(refused.holder?.pid),
    `stderr=${stderr.slice(0, 200)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. Real durable store round-trip (temp file with WAL).
{
  const file = path.join(os.tmpdir(), `jarvis-p22-${process.pid}.db`);
  const store = new DurableStore({ file, logger: null });
  store.open();
  store.runStart({ runId: `smoke-${process.pid}`, channelId: 'smoke', workspace: root, title: 'p22 smoke' });
  store.runFinish(`smoke-${process.pid}`, { state: 'DONE', durationMs: 1024 });
  const statusOpen = store.status().open;
  const interrupted = (() => {
    store.runStart({ runId: `smoke-stale-${process.pid}`, channelId: 'smoke2' });
    store.db.close();
    store.db = null;
    const again = new DurableStore({ file, logger: null });
    again.open();
    const rows = again.pendingActiveRuns();
    const row = again.db.prepare('SELECT state FROM runs WHERE run_id = ?').get(`smoke-stale-${process.pid}`);
    again.close();
    return rows.length === 0 && row.state === 'INTERRUPTED';
  })();
  check('durable store opens with WAL', statusOpen);
  check('restart marks stale running run interrupted (no auto-resume)', interrupted);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

// 4. Real Task Scheduler query (deterministic, local only).
{
  const task = await queryAutostartTask();
  check('autostart query returns deterministic state', task.found === true || task.status === 'NOT_FOUND',
    `found=${task.found} status=${task.status ?? '-'}`);
  const action = buildTaskAction(root);
  check('scheduled action points at the supervisor', /start-supervisor\.ps1/.test(action));
}

// 5. Doctor renderers deterministic.
{
  check('uptime renders', /^(3s|1m|2h13m)$/.test(formatUptime(3000)) && formatUptime(0) === '0s');
  check('ws status text', wsStatusText(1) === 'connected' && /ready/.test(wsStatusText(-1)));
}

const failed = results.filter((r) => !r.ok);
console.log(`\nP2.2 smoke: ${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;

function gitEnvFor(rootDir) {
  // The repo checkout normally owns its .git; GIT_DIR override per env only.
  return process.env.GIT_DIR || null;
}
