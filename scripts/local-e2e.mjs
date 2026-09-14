#!/usr/bin/env node
/**
 * Local end-to-end smoke test — no Discord required.
 *
 * Drives the REAL Claude Code CLI through the REAL bridge components
 * (ClaudeRunner + hook server + ApprovalManager + policy + progress) against a
 * throwaway git repository, and asserts on real side effects:
 *
 *   Phase A  code change -> test -> git commit           (auto-allowed path)
 *   Phase B  destructive shell command -> DENY           (decoy must survive)
 *   Phase C  network commands -> allow once / allow session
 *   Phase D  the real hook client honours once/session scoping deterministically
 *
 * Anything that cannot be proven from the filesystem, git log or recorded hook
 * traffic is reported as a failure rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ClaudeRunner, buildSpawnPlan } from '../src/claude-runner.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { TaskProgress } from '../src/progress.mjs';
import { resolveRoutingEnv, describeRouting, redactForLog } from '../src/win-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SCRIPT = path.join(ROOT, 'scripts', 'approval-hook.mjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function setupDisposableRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-e2e-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'smoke@local'], dir);
  git(['config', 'user.name', 'Discord Agent Control Smoke'], dir);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dac-disposable',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), 'export const name = "dac-disposable";\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'chore: initial disposable repo'], dir);

  // Project-scoped hook, so the smoke test never touches the global user settings.
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT}"`, timeout: 600 }] },
      ],
    },
  }, null, 2) + '\n');

  return dir;
}

/** A stand-in for the phone: consumes scripted decisions per policy rule key. */
function makeScriptedApprover(manager) {
  const asked = [];
  const queues = new Map();
  return {
    asked,
    setScript(ruleKey, actions) { queues.set(ruleKey, [...actions]); },
    presenter: async (req) => {
      const list = queues.get(req.ruleKey);
      const action = list && list.length ? list.shift() : 'deny';
      asked.push({ ruleKey: req.ruleKey, toolName: req.toolName, reason: req.reason, action });
      console.log(`      [phone] ${req.toolName} (${req.ruleKey}) -> ${action}`);
      // Resolve on a later tick so the gate is exercised asynchronously.
      await new Promise((r) => setTimeout(r, 50));
      manager.resolve(req.id, action);
    },
    countFor: (ruleKey) => asked.filter((a) => a.ruleKey === ruleKey).length,
    reset: () => { asked.length = 0; },
  };
}

async function listen(server) {
  return await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function runPhase({ label, cwd, prompt, port, extraEnv, timeoutMs = 300000 }) {
  console.log(`\n--- ${label} ---`);
  console.log(`      prompt: ${prompt.split('\n')[0]} …`);
  const progress = new TaskProgress({ cwd });
  const runner = new ClaudeRunner({
    command: process.env.CLAUDE_COMMAND || 'claude',
    cwd,
    extraEnv,
    onEvent: (e) => {
      if (e.type === 'tool') {
        progress.recordTool(e.tool);
        console.log(`      [progress] ${progress.render().split('\n')[0]} | ${progress.lastAction}`);
      } else if (e.type === 'text') {
        progress.recordText(e.text);
      } else if (e.type === 'model') {
        console.log(`      [model] ${e.model}`);
      }
    },
  });

  process.env.APPROVAL_PORT = String(port);
  const timer = setTimeout(() => runner.stop(), timeoutMs);
  try {
    const result = await runner.send(prompt);
    progress.setState(result.isError ? 'FAILED' : 'DONE');
    console.log(`      [final] ${progress.render().split('\n')[0]} tools=${result.tools.length} cost=$${result.costUsd ?? '?'}`);
    return { result, progress, runner };
  } finally {
    clearTimeout(timer);
    await runner.stop();
  }
}

/**
 * Invoke the production hook client exactly as Claude Code does.
 *
 * Must be async: `spawnSync` blocks this process's event loop, so the approval
 * presenter (which resolves on a timer inside this same process) could never
 * run and the client would hang until its own timeout.
 */
function callHookClient(payload, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, DISCORD_BRIDGE_ACTIVE: '1', APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ permissionDecision: null, error: e.message }));
    child.on('exit', (code) => {
      const trimmed = out.trim();
      if (!trimmed) return resolve({ permissionDecision: null, stderr: err.trim(), status: code });
      try { resolve({ ...JSON.parse(trimmed).hookSpecificOutput, status: code }); }
      catch { resolve({ permissionDecision: null, raw: trimmed, status: code }); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const routing = await resolveRoutingEnv();
  const effectiveEnv = { ...process.env, ...routing.env };
  const routingInfo = describeRouting(effectiveEnv);
  console.log('=== environment ===');
  console.log(`routing source : ${routing.source}`);
  console.log(`routing vars   : ${JSON.stringify(redactForLog(effectiveEnv))}`);
  console.log(`executor       : ${process.env.CLAUDE_COMMAND || 'claude'}`);
  check('env: DeepSeek routing resolved (not silently on the official endpoint)',
    Boolean(routingInfo.base && routingInfo.hasToken), routingInfo.base);

  const secret = ensureHookSecret();
  const approvals = new ApprovalManager({ timeoutMs: 120000 });
  const phone = makeScriptedApprover(approvals);
  phone.setScript('bash-destructive', ['deny']);
  phone.setScript('bash-network', ['allow-once', 'allow-session']);
  approvals.setPresenter(phone.presenter);

  const config = { defaultCwd: process.cwd(), autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };
  const server = createHookServer({ config, approvalManager: approvals, secret });
  const port = await listen(server);
  console.log(`approval hook server listening on 127.0.0.1:${port}`);

  const repo = setupDisposableRepo();
  console.log(`disposable repo: ${repo}`);
  const extraEnv = routing.env;

  // ---------------------------------------------------------------- Phase A
  const phaseA = await runPhase({
    label: 'Phase A — real code change, test, git commit',
    cwd: repo,
    port,
    extraEnv,
    prompt: [
      'You are working in a throwaway Node.js repo. Do exactly this, using tools:',
      '1. Create `src/health.mjs` that exports `export function health() { return { status: "ok" }; }`',
      '2. Create `test/health.test.mjs` using node:test that asserts health().status === "ok".',
      '3. Run the shell command `npm test` and make sure it passes.',
      '4. Run `git add -A` and then `git commit -m "feat: add health endpoint"`.',
      '5. Reply with a one-line summary. Do not run any other shell commands.',
    ].join('\n'),
  });

  const healthPath = path.join(repo, 'src', 'health.mjs');
  check('A1 src/health.mjs was really created', fs.existsSync(healthPath));
  if (fs.existsSync(healthPath)) {
    check('A2 health() returns {"status":"ok"}', /status:\s*["']ok["']/.test(fs.readFileSync(healthPath, 'utf8')));
  }
  check('A3 test file was really created', fs.existsSync(path.join(repo, 'test', 'health.test.mjs')));
  const testRun = spawnSync(process.execPath, ['--test'], { cwd: repo, encoding: 'utf8' });
  check('A4 `node --test` passes on the modified repo', testRun.status === 0, `exit=${testRun.status}`);
  const logA = git(['log', '--oneline'], repo);
  check('A5 a real git commit was created by the agent', /feat: add health endpoint/.test(logA.out), logA.out.split('\n')[0]);
  check('A6 the agent reported a concrete model', Boolean(phaseA.runner.model), phaseA.runner.model || 'unknown');

  // ---------------------------------------------------------------- Phase B
  const decoy = path.join(repo, 'decoy');
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, 'keep-me.txt'), 'must survive a denied delete\n');

  await runPhase({
    label: 'Phase B — destructive command must be denied',
    cwd: repo,
    port,
    extraEnv,
    prompt: [
      'Run exactly this one shell command and nothing else:',
      '`rm -rf decoy`',
      'Then reply with one line saying whether it succeeded.',
    ].join('\n'),
  });

  check('B1 the destructive call really reached the approval gate',
    phone.countFor('bash-destructive') >= 1, `${phone.countFor('bash-destructive')} ask(s)`);
  check('B2 DENY actually prevented the deletion', fs.existsSync(path.join(decoy, 'keep-me.txt')));

  // ---------------------------------------------------------------- Phase C
  const phaseC = await runPhase({
    label: 'Phase C — network commands go through the gate',
    cwd: repo,
    port,
    extraEnv,
    prompt: [
      'Run these three shell commands one at a time using the Bash tool, in this order:',
      '1. `curl -s -o /dev/null -w "%{http_code}" https://example.com`',
      '2. `curl -s -o /dev/null -w "%{http_code}" https://example.com`',
      '3. `curl -s -o /dev/null -w "%{http_code}" https://example.com`',
      'Then reply with one line. Do not run anything else.',
    ].join('\n'),
  });

  const curlCalls = phaseC.result.tools.filter((t) => t.name === 'Bash' && /curl/.test(t.input?.command || '')).length;
  const networkAsks = phone.countFor('bash-network');
  check('C1 network calls were gated instead of running freely', networkAsks >= 1, `${networkAsks} ask(s)`);
  check('C2 allow-session stopped repeated prompts for the same rule',
    curlCalls < 2 || networkAsks < curlCalls, `${networkAsks} ask(s) for ${curlCalls} curl call(s)`);

  // ---------------------------------------------------------------- Phase D
  console.log('\n--- Phase D — real hook client: once vs session scoping ---');
  phone.setScript('bash-network', ['allow-once', 'allow-session']);
  phone.reset();
  const scopeSession = 'dac-scope-session';
  const payload = (command) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: repo,
    session_id: scopeSession,
    permission_mode: 'bypassPermissions',
  });

  const d1 = await callHookClient(payload('curl -s https://example.com'), port);
  const d2 = await callHookClient(payload('curl -s https://example.com'), port);
  const d3 = await callHookClient(payload('curl -s https://example.com'), port);
  const d4 = await callHookClient(payload('curl -s https://example.com'), port);

  check('D1 first risky call is allowed once', d1.permissionDecision === 'allow', d1.permissionDecision);
  check('D2 the second identical call asks again (allow once is one-shot)',
    d2.permissionDecision === 'allow' && phone.countFor('bash-network') === 2, `${phone.countFor('bash-network')} ask(s)`);
  check('D3 the third call is auto-allowed without asking (allow session scoped to this session)',
    d3.permissionDecision === 'allow' && phone.countFor('bash-network') === 2);
  check('D4 further identical calls stay auto-allowed', d4.permissionDecision === 'allow' && phone.countFor('bash-network') === 2);

  const otherSession = await callHookClient({ ...payload('curl -s https://example.com'), session_id: 'dac-other-session' }, port);
  check('D5 a different session is NOT covered by the earlier session grant',
    otherSession.permissionDecision === 'deny', `decision=${otherSession.permissionDecision} (script exhausted -> deny)`);

  // ---------------------------------------------------------------- Phase E
  console.log('\n--- Phase E — plain Claude Code must be unaffected by the installed hook ---');
  const asksBefore = phone.asked.length;
  const plainPrompt = 'Read the file src/health.mjs and reply with only the value of the status field.';
  const plan = buildSpawnPlan(process.env.CLAUDE_COMMAND || 'claude', ['-p', plainPrompt, '--output-format', 'json', '--dangerously-skip-permissions']);
  const plainEnv = { ...process.env, ...extraEnv };
  delete plainEnv.DISCORD_BRIDGE_ACTIVE; // exactly what a normal local / WebUI session looks like
  const plain = spawnSync(plan.file, plan.args, {
    cwd: repo, env: plainEnv, shell: plan.shell, encoding: 'utf8', windowsHide: true, timeout: 300000,
  });
  const plainOut = `${plain.stdout || ''}${plain.stderr || ''}`;
  check('E1 plain Claude Code still runs (hook is inert without DISCORD_BRIDGE_ACTIVE)', plain.status === 0, `exit=${plain.status}`);
  check('E2 the plain session really read the file instead of being blocked', /"ok"|status.*ok/i.test(plainOut));
  check('E3 no approval was requested for the plain session', phone.asked.length === asksBefore);

  // ------------------------------------------------------------- summary
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`disposable repo kept for inspection: ${repo}`);

  if (failed.length) {
    console.log('\nFAILED CHECKS:');
    for (const r of failed) console.log(` - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[e2e fatal]', error?.stack || error);
  process.exit(1);
});
