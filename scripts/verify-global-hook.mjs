#!/usr/bin/env node
/**
 * Verifies the *installed global* hook (the configuration the bridge actually
 * relies on), as opposed to the project-scoped hook used by the other smoke tests.
 *
 *   node scripts/verify-global-hook.mjs
 *
 * Two runs against a throwaway repo that has NO project-level Claude settings:
 *
 *   1. with DISCORD_BRIDGE_ACTIVE=1  -> the global hook must fire
 *   2. without it                    -> the hook must stay inert and the tool
 *                                       must still execute normally
 *
 * Run `scripts/install-global-hook.ps1` first.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSpawnPlan } from '../src/claude-runner.mjs';
import { ensureHookSecret } from '../src/hook-server.mjs';
import { resolveRoutingEnv } from '../src/win-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function readGlobalHookCommand() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return { hookCommand: null, reason: 'no ~/.claude/settings.json' };
  const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) {
    // A BOM makes the file invalid JSON for strict parsers, which would silently
    // stop Claude Code from loading the hook at all.
    return { hookCommand: null, reason: 'settings.json starts with a UTF-8 BOM (invalid JSON) — re-run scripts/install-global-hook.ps1' };
  }
  let settings;
  try { settings = JSON.parse(raw); }
  catch (e) { return { hookCommand: null, reason: `settings.json is not valid JSON: ${e.message}` }; }

  for (const group of settings?.hooks?.PreToolUse ?? []) {
    for (const hook of group.hooks ?? []) {
      if (String(hook.command || '').includes('approval-hook.mjs')) return { hookCommand: hook.command, reason: null };
    }
  }
  return { hookCommand: null, reason: 'no approval-hook.mjs entry in hooks.PreToolUse' };
}

function setupRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-globalhook-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dac-global-hook-probe', version: '1.0.0' }, null, 2));
  // Deliberately NO .claude/settings.json here.
  return dir;
}

/**
 * Run Claude Code.
 *
 * MUST be async. `spawnSync` blocks this process's event loop, and the recording
 * hook server runs in this same process, so the hook client could never get a
 * response and Claude would hang until it was killed. Same trap as
 * `callHookClient` in local-e2e.mjs.
 */
function runClaude({ cwd, prompt, env }) {
  const plan = buildSpawnPlan(process.env.CLAUDE_COMMAND || 'claude', [
    '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions',
  ]);
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd, env, shell: plan.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 300000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, out: `${out}\n${e.message}` }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out }); });
  });
}

async function main() {
  const { hookCommand, reason } = readGlobalHookCommand();
  check('~/.claude/settings.json is valid JSON and installs the hook', Boolean(hookCommand),
    hookCommand || `${reason} — run scripts/install-global-hook.ps1`);
  if (!hookCommand) return finish();

  const secret = ensureHookSecret();
  const recorded = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    recorded.push({ authOk: req.headers.authorization === `Bearer ${secret}`, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'verify-global-hook' },
    }));
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const repo = setupRepo();
  const routing = await resolveRoutingEnv();
  const baseEnv = { ...process.env, ...routing.env, APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port) };
  const prompt = 'Read the file package.json and reply with only the value of the name field.';
  console.log(`probe repo: ${repo}`);
  console.log(`recording hook server on 127.0.0.1:${port}`);

  try {
    console.log('\n--- run 1: bridge session (DISCORD_BRIDGE_ACTIVE=1) ---');
    const bridgeRun = await runClaude({ cwd: repo, prompt, env: { ...baseEnv, DISCORD_BRIDGE_ACTIVE: '1' } });
    check('run 1 completed', bridgeRun.status === 0, `exit=${bridgeRun.status}`);
    check('the global hook really fired for a bridge session', recorded.length >= 1, `${recorded.length} hook call(s)`);
    if (recorded.length) {
      let body = {};
      try { body = JSON.parse(recorded[0].body); } catch { /* ignore */ }
      check('the hook call carried a valid local secret', recorded[0].authOk === true);
      check('the hook call carried the tool + cwd Claude Code reports',
        body.tool_name === 'Read' && Boolean(body.cwd), `${body.tool_name} @ ${body.cwd}`);
    }
    check('the tool still executed (allow path)', /dac-global-hook-probe/.test(bridgeRun.out));

    console.log('\n--- run 2: ordinary local session (no DISCORD_BRIDGE_ACTIVE) ---');
    const before = recorded.length;
    const plainEnv = { ...baseEnv };
    delete plainEnv.DISCORD_BRIDGE_ACTIVE;
    const plainRun = await runClaude({ cwd: repo, prompt, env: plainEnv });
    check('run 2 completed', plainRun.status === 0, `exit=${plainRun.status}`);
    check('the hook stayed inert for an ordinary session', recorded.length === before, `${recorded.length - before} extra call(s)`);
    check('the tool still executed normally', /dac-global-hook-probe/.test(plainRun.out));
  } finally {
    server.close();
  }

  return finish(repo);
}

function finish(repo) {
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (repo) console.log(`probe repo kept for inspection: ${repo}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error('[verify-global-hook fatal]', error?.stack || error);
  process.exit(1);
});
