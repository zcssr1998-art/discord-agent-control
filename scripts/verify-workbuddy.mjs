#!/usr/bin/env node
/**
 * Verifies that the agent runs on the WorkBuddy free backend and nowhere else.
 *
 *   npm run verify:workbuddy
 *
 * Checks, all against a real agent process:
 *   [1] the WorkBuddy free backend is reachable
 *   [2] the agent shell is actually driven by that backend (not just configured to be)
 *   [3] real tool calls happen (real files, real shell)
 *   [4] every metered credential variable is blocked in the child environment
 *   [5] there is no fallback: a wrong backend fails the run instead of billing someone
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ClaudeRunner } from '../src/claude-runner.mjs';
import { stripPaidCredentials, classifyBackend, assertBackendAllowed, billingRoute, resolveWorkbuddyCli, WORKBUDDY_COMMAND_KEYWORD, PAID_CREDENTIAL_VARS, PAID_BASE_URL_VARS } from '../src/backend.mjs';
import { withTimeout } from '../src/limits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Same resolution the bridge uses, so this verifies the real configuration. */
function resolveExecutor() {
  const raw = String(process.env.CLAUDE_COMMAND ?? '').trim();
  if (!raw || raw === WORKBUDDY_COMMAND_KEYWORD) {
    const cli = resolveWorkbuddyCli();
    if (cli) return cli;
    if (raw === WORKBUDDY_COMMAND_KEYWORD) throw new Error('CLAUDE_COMMAND=workbuddy but the WorkBuddy CLI was not found. Set WORKBUDDY_CLI.');
  }
  return raw || 'claude';
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function setupRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-wb-verify-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'verify@local'], dir);
  git(['config', 'user.name', 'WB Verify'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# workbuddy backend verification\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'chore: init'], dir);
  return dir;
}

async function runAgent({ command, cwd, env, envUnset, prompt, timeoutMs = 300000 }) {
  let init = null;
  const tools = [];
  const runner = new ClaudeRunner({
    command,
    cwd,
    extraEnv: env,
    envUnset,
    onEvent: (event) => {
      if (event.type === 'init') init = event;
      if (event.type === 'tool') tools.push(event.tool);
    },
  });
  try {
    const result = await withTimeout(runner.send(prompt), timeoutMs, { onTimeout: () => runner.stop(), label: 'verify run' });
    return { result, init, tools };
  } finally {
    await runner.stop();
  }
}

async function main() {
  const command = resolveExecutor();
  const expected = process.env.AGENT_BACKEND || 'workbuddy-free-dsf';
  console.log('=== workbuddy backend verification ===');
  console.log(`executor : ${command}`);
  console.log(`expected : ${expected}\n`);

  // [4] blocked credentials -------------------------------------------------
  const childEnv = { ...process.env };
  const presentPaid = [...PAID_CREDENTIAL_VARS, ...PAID_BASE_URL_VARS].filter((n) => childEnv[n] !== undefined);
  const envUnset = stripPaidCredentials(childEnv);
  check('[4] metered credential variables are blocked in the child environment',
    presentPaid.every((n) => envUnset.includes(n)),
    presentPaid.length ? `blocked: ${envUnset.join(', ')}` : 'none were present in this shell');

  const repo = setupRepo();
  console.log(`disposable repo: ${repo}\n`);

  // [1] + [2] backend reachable and actually in use --------------------------
  const textRun = await runAgent({
    command,
    cwd: repo,
    env: childEnv,
    envUnset,
    prompt: 'Reply with exactly: WB_DSF_OK',
  });
  const backend = classifyBackend({ apiKeySource: textRun.init?.apiKeySource, model: textRun.init?.model });
  check('[1] the WorkBuddy free backend answered a text request',
    /WB_DSF_OK/.test(textRun.result.text || ''), JSON.stringify(textRun.result.text || '').slice(0, 80));
  check('[2] the request was served by the WorkBuddy gateway, not a paid API',
    backend.free, `apiKeySource=${backend.apiKeySource ?? 'none'} backend=${backend.label}`);
  check('[2b] the backend is the expected one', backend.id === expected, backend.id);
  console.log(`      model=${backend.model ?? 'unknown'} billing=${billingRoute(backend)}`);

  // [3] real tool calls -----------------------------------------------------
  const agentRun = await runAgent({
    command,
    cwd: repo,
    env: childEnv,
    envUnset,
    prompt: [
      'Use your tools to do exactly this:',
      '1) create a file named wb-verify.txt containing exactly the text WB_DSF_AGENT_OK',
      '2) read wb-verify.txt back to confirm the contents',
      '3) run the shell command `git status --short`',
      'Then reply with a one-line summary.',
    ].join('\n'),
  });

  const target = path.join(repo, 'wb-verify.txt');
  check('[3] the agent performed real tool calls', agentRun.tools.length >= 2, `${agentRun.tools.length} tool call(s): ${[...new Set(agentRun.tools.map((t) => t.name))].join(',')}`);
  check('[3b] the file really exists on disk', fs.existsSync(target));
  if (fs.existsSync(target)) {
    check('[3c] the file contains the expected text', fs.readFileSync(target, 'utf8').trim() === 'WB_DSF_AGENT_OK', fs.readFileSync(target, 'utf8').trim());
  }
  const status = git(['status', '--short'], repo);
  check('[3d] git sees the agent-created file', /wb-verify\.txt/.test(status), status.replace(/\n/g, ' '));

  // [5] no fallback ---------------------------------------------------------
  const paid = classifyBackend({ apiKeySource: 'api.deepseek.com' });
  const verdict = assertBackendAllowed(paid, { allowPaidFallback: false, expected });
  check('[5] a non-WorkBuddy backend would be refused, not silently billed',
    verdict.ok === false && /paid fallback is disabled/.test(verdict.reason), verdict.reason.slice(0, 90));
  check('[5b] paid fallback is off for this run', (process.env.ALLOW_PAID_FALLBACK || 'false') !== 'true');

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`backend: ${backend.label} | model: ${backend.model ?? 'unknown'} | billing: ${billingRoute(backend)} | paid fallback: DISABLED`);
  console.log(`disposable repo kept for inspection: ${repo}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error('[verify:workbuddy fatal]', error?.stack || error);
  process.exit(1);
});
