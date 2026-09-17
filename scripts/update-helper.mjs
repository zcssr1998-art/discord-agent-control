#!/usr/bin/env node
/**
 * P2.2.6 Supervisor-side update helper.
 *
 * The Supervisor owns process replacement and the last-known-good rollback.
 * This helper keeps the git/state logic in one testable JS module instead of
 * duplicating git plumbing in PowerShell.
 *
 * Usage (called by scripts/start-supervisor.ps1 after repeated post-update
 * startup failures):
 *
 *   node scripts/update-helper.mjs status   --root <checkout> [--state <file>]
 *   node scripts/update-helper.mjs rollback --root <checkout> [--state <file>]
 *
 * It never prints a token/key/cookie and only ever resets to a recorded
 * previous known-good SHA; it refuses if the live HEAD is not the applied
 * candidate.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpdateState, rollbackToPreviousGood, shortSha, UPDATE_STATUS } from '../src/updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const command = process.argv[2] || 'status';
const defaultRoot = path.resolve(__dirname, '..');
const root = path.resolve(argValue('--root', defaultRoot));
const stateFile = path.resolve(argValue('--state', path.join(root, 'data', 'update-state.json')));

async function main() {
  if (command === 'status') {
    const store = readUpdateState(stateFile);
    const s = store.state;
    console.log(JSON.stringify({
      status: s.status || UPDATE_STATUS.UP_TO_DATE,
      localSha: s.localSha,
      remote: s.remote,
      branch: s.branch,
      remoteSha: s.remoteSha,
      relation: s.relation,
      paused: Boolean(s.paused),
      dirty: Boolean(s.dirty),
      pendingSha: s.pendingSha,
      previousGoodSha: s.previousGoodSha,
      appliedSha: s.appliedSha,
      applyPendingVerify: Boolean(s.applyPendingVerify),
      quarantinedSha: s.quarantined?.sha ?? null,
      lastFailure: s.lastFailure ?? null,
      short: {
        local: shortSha(s.localSha),
        remote: shortSha(s.remoteSha),
        pending: shortSha(s.pendingSha),
      },
    }, null, 2));
    return;
  }

  if (command === 'rollback') {
    const result = await rollbackToPreviousGood({ root, stateFile, reason: 'post-update startup failure' });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
    return;
  }

  console.error(`unknown command: ${command}`);
  process.exit(2);
}

main().catch((error) => {
  console.error(`update-helper error: ${error?.message || error}`);
  process.exit(1);
});
