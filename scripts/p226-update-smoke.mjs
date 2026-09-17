#!/usr/bin/env node
/**
 * P2.2.6 safe self-update - focused deterministic smoke.
 *
 * No network, no Discord, no secrets, no long waits. It drives the REAL
 * `src/updater.mjs` against REAL temporary Git repositories (a bare origin plus
 * working clones), so every fast-forward / dirty / diverged / rollback / quarantine
 * decision is exercised against actual git plumbing, not mocks.
 *
 * It is also the candidate gate run inside a staging worktree, so it only imports
 * dependency-free modules (updater.mjs + commands.mjs).
 *
 * Run: npm run smoke:p226-update
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  Updater,
  UpdateStateStore,
  UPDATE_STATUS,
  RELATION,
  deriveStatus,
  rollbackToPreviousGood,
  runCandidateGate,
  isValidSha,
  shortSha,
} from '../src/updater.mjs';
import { buildCommandPayloads, compareCommandSchema, workTaskMaxLength } from '../src/commands.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd, args) {
  try { git(cwd, args); return true; } catch { return false; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p226-smoke-'));
const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } };

/**
 * Create an origin bare repo + a `work` clone on branch main. `advance()` pushes
 * a new commit to origin from a separate seed repo, mimicking a remote advance.
 */
function makePair(label) {
  const base = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  fs.mkdirSync(origin, { recursive: true });
  git(origin, ['init', '--bare', '--initial-branch=main']);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '--initial-branch=main']);
  git(seed, ['config', 'user.email', 'smoke@example.com']);
  git(seed, ['config', 'user.name', 'Smoke']);
  git(seed, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v0\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'v0']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-u', 'origin', 'main']);

  git(base, ['clone', origin, work]);
  git(work, ['config', 'user.email', 'smoke@example.com']);
  git(work, ['config', 'user.name', 'Smoke']);
  git(work, ['config', 'core.autocrlf', 'false']);
  // Re-materialize tracked files under the LF policy so a Windows global
  // autocrlf cannot make the fresh clone look dirty to the updater.
  git(work, ['reset', '--hard', 'HEAD']);

  let version = 0;
  const advance = () => {
    version += 1;
    fs.writeFileSync(path.join(seed, 'app.txt'), `v${version}\n`);
    fs.writeFileSync(path.join(seed, `note-${version}.txt`), `note ${version}\n`);
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', `v${version}`]);
    git(seed, ['push', 'origin', 'main']);
    return git(origin, ['rev-parse', 'main']);
  };
  const head = () => git(work, ['rev-parse', 'HEAD']);
  return { base, origin, seed, work, advance, head };
}

function makeUpdater(pair, overrides = {}) {
  const stateFile = path.join(pair.base, `update-state-${Math.random().toString(16).slice(2)}.json`);
  const restarts = [];
  const notes = [];
  const logs = [];
  const flags = { safe: true, gateOk: true, gateReason: 'injected gate failure' };
  const updater = new Updater({
    root: pair.work,
    remote: 'origin',
    branch: 'main',
    enabled: true,
    intervalMs: 1,
    stateFile,
    safeToRestart: async () => ({ safe: flags.safe, reasons: flags.safe ? [] : ['active Work chan-1'] }),
    onRequestRestart: async (info) => { restarts.push(info); },
    onNotify: async (event) => { notes.push(event); },
    candidateGate: async () => (flags.gateOk ? { ok: true } : { ok: false, reason: flags.gateReason }),
    logger: { log: (line) => { logs.push(String(line)); } },
    ...overrides,
  });
  return { updater, flags, restarts, notes, logs, stateFile };
}

async function main() {
  // ------------------------------------------------------------------ pure
  check('pure: deriveStatus disabled', deriveStatus({ enabled: false }).status === UPDATE_STATUS.DISABLED);
  check('pure: deriveStatus up-to-date', deriveStatus({ localSha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), relation: RELATION.UP_TO_DATE }).status === UPDATE_STATUS.UP_TO_DATE);
  check('pure: deriveStatus busy -> pending', deriveStatus({ localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), relation: RELATION.AHEAD, safe: false }).status === UPDATE_STATUS.UPDATE_PENDING);
  check('pure: deriveStatus diverged -> blocked', deriveStatus({ localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), relation: RELATION.DIVERGED }).status === UPDATE_STATUS.BLOCKED);
  check('pure: isValidSha', isValidSha('a'.repeat(40)) && !isValidSha('nope'));
  check('pure: shortSha never invents', shortSha('a'.repeat(40)) === 'aaaaaaa' && shortSha(null) === 'unknown');

  // ------------------------------------------------------------ up_to_date
  {
    const pair = makePair('utd');
    const { updater, restarts } = makeUpdater(pair);
    const v = await updater.refresh({ force: true });
    check('up to date: status UP_TO_DATE', v.status === UPDATE_STATUS.UP_TO_DATE, v.status);
    check('up to date: no restart requested', restarts.length === 0 && pair.head() === git(pair.origin, ['rev-parse', 'main']));
    updater.stop();
  }

  // --------------------------------------- fast-forward + idle auto deploy
  {
    const pair = makePair('ff');
    const { updater, restarts, stateFile } = makeUpdater(pair);
    const before = pair.head();
    const remote = pair.advance();
    const v = await updater.refresh({ force: true });
    check('fast-forward: candidate applied', pair.head() === remote && v.appliedSha === remote, `head=${shortSha(pair.head())}`);
    check('fast-forward: previous known-good recorded', v.previousGoodSha === before, shortSha(v.previousGoodSha));
    check('fast-forward: exactly one restart requested', restarts.length === 1 && restarts[0].sha === remote);
    check('fast-forward: applyPendingVerify set', v.applyPendingVerify === true);

    // Simulate the Supervisor relaunching the new code: a fresh process sharing
    // the same durable state verifies the running SHA exactly once.
    const { updater: after } = makeUpdater(pair, { stateFile });
    const verified = await after.reconcileAfterRestart();
    check('restart: running SHA verified once', verified.status === UPDATE_STATUS.UP_TO_DATE && verified.applyPendingVerify === false && verified.lastAppliedSha === remote);
    const again = await after.refresh({ force: true });
    check('restart: same candidate never re-deploys', again.status === UPDATE_STATUS.UP_TO_DATE && restarts.length === 1);
    after.stop();
    updater.stop();
  }

  // ------------------- running process stale vs externally advanced checkout
  {
    const pair = makePair('stale');
    const v0 = pair.head();
    const remote = pair.advance();
    // The checkout advances externally (e.g. a manual pull) but the process was
    // NOT restarted: freshness must be judged by the running SHA, not the HEAD,
    // otherwise a stale runtime would look current (the original drift bug).
    git(pair.work, ['fetch', '--quiet', 'origin', 'main']);
    git(pair.work, ['merge', '--ff-only', 'origin/main']);
    check('stale runtime: checkout advanced but process SHA is old', pair.head() === remote && v0 !== remote);

    const { updater, restarts, stateFile } = makeUpdater(pair, { runningSha: v0 });
    const v = await updater.refresh({ force: true });
    check('stale runtime: not reported UP_TO_DATE', v.status !== UPDATE_STATUS.UP_TO_DATE, v.status);
    check('stale runtime: restart requested to run the fresh code', restarts.length === 1 && v.appliedSha === remote && v.previousGoodSha === v0);
    updater.stop();

    const { updater: fresh } = makeUpdater(pair, { stateFile, runningSha: remote });
    const verified = await fresh.reconcileAfterRestart();
    check('stale runtime: fresh process verifies and goes UP_TO_DATE', verified.status === UPDATE_STATUS.UP_TO_DATE && verified.applyPendingVerify === false);
    fresh.stop();
  }

  // ------------------------------------------- Work busy -> pending -> idle
  {
    const pair = makePair('busy');
    const { updater, flags, restarts } = makeUpdater(pair);
    const before = pair.head();
    pair.advance();
    flags.safe = false;
    let v = await updater.refresh({ force: true });
    check('busy: status UPDATE_PENDING', v.status === UPDATE_STATUS.UPDATE_PENDING, v.status);
    check('busy: no deploy while Work runs', pair.head() === before && restarts.length === 0);
    flags.safe = true;
    v = await updater.refresh({ force: true });
    check('idle after busy: auto deploy applies', pair.head() !== before && restarts.length === 1 && v.appliedSha === pair.head());
    updater.stop();
  }

  // ------------------------------------------------------ dirty -> blocked
  {
    const pair = makePair('dirty');
    const { updater, restarts } = makeUpdater(pair);
    const before = pair.head();
    fs.writeFileSync(path.join(pair.work, 'app.txt'), 'owner local edit\n');
    pair.advance();
    const v = await updater.refresh({ force: true });
    check('dirty: BLOCKED', v.status === UPDATE_STATUS.BLOCKED, v.status);
    check('dirty: local HEAD untouched', pair.head() === before && restarts.length === 0);
    check('dirty: local edit preserved', fs.readFileSync(path.join(pair.work, 'app.txt'), 'utf8').includes('owner local edit'));
    updater.stop();
  }

  // --------------------------------------------------- diverged -> blocked
  {
    const pair = makePair('div');
    const { updater, restarts } = makeUpdater(pair);
    const before = pair.head();
    // local commit and a different remote commit -> neither is an ancestor.
    fs.writeFileSync(path.join(pair.work, 'local.txt'), 'local\n');
    git(pair.work, ['add', '.']);
    git(pair.work, ['commit', '-m', 'local-only']);
    pair.advance();
    const v = await updater.refresh({ force: true });
    check('diverged: BLOCKED', v.status === UPDATE_STATUS.BLOCKED && v.relation === RELATION.DIVERGED, `${v.status}/${v.relation}`);
    check('diverged: no merge/rebase/reset performed', pair.head() !== before && git(pair.work, ['log', '-1', '--format=%s']) === 'local-only' && restarts.length === 0);
    updater.stop();
  }

  // ------------------------------- candidate fail -> rollback + quarantine
  {
    const pair = makePair('cand');
    const { updater, flags, restarts, stateFile } = makeUpdater(pair);
    const before = pair.head();
    const remote = pair.advance();
    flags.gateOk = false;
    const v = await updater.refresh({ force: true });
    check('candidate fail: LAST_UPDATE_FAILED', v.status === UPDATE_STATUS.LAST_UPDATE_FAILED, v.status);
    check('candidate fail: live checkout unchanged (rollback is a no-op, never applied)', pair.head() === before && restarts.length === 0);
    check('candidate fail: bad SHA quarantined', v.quarantinedSha === remote, shortSha(v.quarantinedSha));

    // Quarantine must stop an immediate retry against the SAME remote SHA.
    flags.gateOk = true;
    const retry = await updater.refresh({ force: true });
    check('quarantine: same bad SHA cannot cause a restart loop', retry.status === UPDATE_STATUS.BLOCKED && restarts.length === 0 && pair.head() === before);

    // A NEW remote SHA clears the quarantine and retries.
    const remote2 = pair.advance();
    const v2 = await updater.refresh({ force: true });
    check('quarantine: a new remote SHA allows retry', pair.head() === remote2 && v2.appliedSha === remote2 && restarts.length === 1);

    // Direct supervisor-side rollback: applied candidate -> restore known-good.
    const store = new UpdateStateStore(stateFile);
    check('rollback: previous known-good distinct from applied', store.state.previousGoodSha === before && store.state.appliedSha === remote2);
    const rb = await rollbackToPreviousGood({ root: pair.work, stateFile });
    const after = new UpdateStateStore(stateFile);
    check('rollback: restores previous known-good SHA', rb.ok && pair.head() === before, `head=${shortSha(pair.head())}`);
    check('rollback: quarantines the failed SHA', after.state.quarantined?.sha === remote2 && after.state.applyPendingVerify === false);
    updater.stop();
  }

  // ------------------------------------------------ pause / resume persists
  {
    const pair = makePair('pause');
    const { updater, restarts, flags, stateFile } = makeUpdater(pair);
    updater.pause('owner');
    check('pause: persisted across a new store', new UpdateStateStore(stateFile).state.paused === true);
    pair.advance();
    const pending = await updater.refresh({ force: true });
    check('pause: no deploy while paused', pending.status === UPDATE_STATUS.PAUSED && restarts.length === 0);
    flags.gateOk = true;
    const resumed = await updater.resume();
    check('resume: clears pause and deploys', new UpdateStateStore(stateFile).state.paused === false && restarts.length === 1 && resumed.appliedSha === pair.head());
    updater.stop();
  }

  // ------------------------------------------- real candidate gate worktree
  {
    const pair = makePair('gate');
    const before = pair.head();
    // A candidate that lacks the gate scripts must fail closed.
    const remote = pair.advance();
    git(pair.work, ['fetch', '--quiet', 'origin', 'main']);
    const missing = await runCandidateGate({ root: pair.work, sha: remote });
    check('gate: missing gate scripts fails closed', missing.ok === false);
    const leftovers = git(pair.work, ['worktree', 'list']).split(/\r?\n/).filter((line) => line.includes('jarvis-update-cand'));
    check('gate: staging worktree always cleaned up', leftovers.length === 0);

    // A candidate that contains the gate scripts passes in an isolated worktree.
    const seed2 = pair.seed;
    fs.mkdirSync(path.join(seed2, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(seed2, 'scripts', 'check-syntax.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(seed2, 'scripts', 'p226-update-smoke.mjs'), 'process.exit(0);\n');
    git(seed2, ['add', '.']);
    git(seed2, ['commit', '-m', 'add gate scripts']);
    git(seed2, ['push', 'origin', 'main']);
    git(pair.work, ['fetch', '--quiet', 'origin', 'main']);
    const goodSha = git(pair.work, ['rev-parse', 'origin/main']);
    const pass = await runCandidateGate({ root: pair.work, sha: goodSha });
    check('gate: candidate with passing scripts is accepted', pass.ok === true, pass.reason || '');
    const liveHead = pair.head();
    check('gate: live checkout untouched by staging worktree', liveHead === before);
  }

  // --------------------------------------------------- command schema checks
  {
    const desired = buildCommandPayloads();
    const work = desired.find((command) => command.name === 'work');
    check('schema: local /work task max_length is 6000', work.options[0].max_length === 6000 && workTaskMaxLength(desired) === 6000);

    // Faithful fake of the fetched remote JSON (raw snake_case, as Discord REST returns).
    const fetchedGood = JSON.parse(JSON.stringify(desired));
    check('schema: fetched remote max_length=6000 matches', compareCommandSchema(fetchedGood, desired).ok === true);
    check('schema: reported /work max_length from fetched schema', compareCommandSchema(fetchedGood, desired).workTaskMaxLength === 6000);

    const fetchedBad = JSON.parse(JSON.stringify(desired));
    fetchedBad.find((command) => command.name === 'work').options[0].max_length = 1500;
    const bad = compareCommandSchema(fetchedBad, desired);
    check('schema: a stale 1500 remote schema is a mismatch', bad.ok === false && bad.workTaskMaxLength === 1500);

    // discord.js-style objects expose the raw payload via toJSON()/camelCase.
    const discordJsLike = desired.map((command) => ({ toJSON: () => JSON.parse(JSON.stringify(command)) }));
    discordJsLike.find((command) => command.toJSON().name === 'work').toJSON = () => {
      const raw = JSON.parse(JSON.stringify(work));
      raw.options[0].maxLength = raw.options[0].max_length;
      delete raw.options[0].max_length;
      return raw;
    };
    check('schema: discord.js toJSON()/maxLength normalization', compareCommandSchema(discordJsLike, desired).ok === true);
  }

  // ------------------------------------------------------- secret redaction
  {
    const pair = makePair('secret');
    const { updater, flags, logs, notes } = makeUpdater(pair);
    pair.advance();
    flags.gateOk = false;
    flags.gateReason = 'auth failed with token sk-abcdef1234567890 leaked';
    const v = await updater.refresh({ force: true });
    const allLogs = logs.join('\n');
    const allNotes = JSON.stringify(notes);
    check('secrets: raw token absent from updater logs', !allLogs.includes('sk-abcdef1234567890'));
    check('secrets: raw token absent from notifications', !allNotes.includes('sk-abcdef1234567890'));
    check('secrets: persisted failure reason is redacted', !JSON.stringify(v.lastFailure).includes('sk-abcdef1234567890'));
    updater.stop();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`SMOKE ERROR: ${error?.stack || error?.message || error}`);
  cleanup();
  process.exit(1);
});
