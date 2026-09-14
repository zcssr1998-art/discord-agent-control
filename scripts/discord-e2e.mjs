#!/usr/bin/env node
/**
 * End-to-end smoke of the full loop with only Discord's network faked.
 *
 * Real: Claude Code CLI, the PreToolUse hook, the hook server, the policy, the
 * approval manager, the DiscordControlPlane (commands, progress throttling,
 * approval buttons, session bookkeeping), git, tests.
 * Fake: the Discord transport only (see tests/helpers/fake-discord.mjs).
 *
 * The "phone" is simulated by watching the posted approval messages and tapping
 * buttons, i.e. reacting to exactly what a human would see.
 *
 *   node scripts/discord-e2e.mjs
 *
 * Run this before the real token test: if this is green, the only untested hop
 * is Discord's own servers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DiscordControlPlane } from '../src/discord-ui.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { StateStore } from '../src/state.mjs';
import { RunLogger } from '../src/logger.mjs';
import { resolveRoutingEnv, describeRouting, redactForLog } from '../src/win-env.mjs';
import { resolveExecutorCommand, stripPaidCredentials } from '../src/backend.mjs';
import { FakeDiscord } from '../tests/helpers/fake-discord.mjs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-discord-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'smoke@local'], dir);
  git(['config', 'user.name', 'Discord E2E Smoke'], dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dac-discord-disposable', version: '1.0.0', type: 'module', scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), 'export const name = "dac";\n');
  fs.mkdirSync(path.join(dir, 'decoy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'decoy', 'keep-me.txt'), 'must survive a denied delete\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'chore: initial disposable repo'], dir);

  // Written for both shells: the Claude Code CLI reads .claude, the WorkBuddy
  // agent CLI reads .codebuddy.
  const settingsJson = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT}"`, timeout: 600 }] }] },
  }, null, 2) + '\n';
  for (const agentDir of ['.claude', '.codebuddy']) {
    fs.mkdirSync(path.join(dir, agentDir), { recursive: true });
    fs.writeFileSync(path.join(dir, agentDir, 'settings.json'), settingsJson);
  }
  return dir;
}

/** Reacts to approval messages exactly like a human on a phone would. */
function startAutoPhone(fake, { decide }) {
  const handled = new Set();
  const decisions = [];
  const timer = setInterval(async () => {
    for (const message of fake.messages) {
      const ids = message.buttonIds.filter((id) => id.startsWith('ap:'));
      if (!ids.length) continue;
      const requestId = ids[0].split(':')[1];
      if (handled.has(requestId)) continue;
      handled.add(requestId);

      const action = decide(message.content);
      const target = ids.find((id) => id.endsWith(`:${action}`)) || ids.find((id) => id.endsWith(':deny'));
      decisions.push({ action, content: message.content.split('\n').slice(0, 4).join(' | ') });
      console.log(`      [phone] tapping ${action}  <-  ${message.content.split('\n')[3] || ''}`);
      try { await fake.clickButton(target); } catch (e) { console.log(`      [phone] click failed: ${e.message}`); }
    }
  }, 250);
  return { stop: () => clearInterval(timer), decisions };
}

/**
 * Summarise the run transcript on disk.
 *
 * `stdoutLines` is how much raw Claude output there was; `toolCalls`/`textBlocks`
 * are the meaningful events. Discord must track the latter, not the former.
 */
function countTranscript(logDir) {
  const stats = { toolCalls: 0, textBlocks: 0, stdoutLines: 0 };
  for (const file of fs.readdirSync(logDir)) {
    const full = path.join(logDir, file);
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.stream !== 'stdout' || typeof entry.text !== 'string') continue;
      stats.stdoutLines += 1;
      let event;
      try { event = JSON.parse(entry.text); } catch { continue; }
      if (event.type !== 'assistant') continue;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') stats.toolCalls += 1;
        if (block.type === 'text' && String(block.text || '').trim()) stats.textBlocks += 1;
      }
    }
  }
  return stats;
}

const STATUS_LINE = /^(🆕 TASK CREATED|🧠 PLANNING|🟡 RUNNING|🧪 TESTING|🔐 WAITING_APPROVAL|✅ DONE|❌ FAILED) · /;

async function waitFor(predicate, { timeoutMs = 300000, intervalMs = 500, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const routing = await resolveRoutingEnv();
  const effective = { ...process.env, ...routing.env };
  const info = describeRouting(effective);
  const extraEnv = { ...process.env };
  const envUnset = stripPaidCredentials(extraEnv);
  console.log('=== environment ===');
  console.log(`routing source : ${routing.source}`);
  console.log(`routing vars   : ${JSON.stringify(redactForLog(effective))}`);
  console.log(`paid credential vars blocked: ${envUnset.length ? envUnset.join(', ') : '(none present)'}`);
  check('env: the agent process cannot see any metered credential',
    !extraEnv.ANTHROPIC_AUTH_TOKEN && !extraEnv.ANTHROPIC_API_KEY && !extraEnv.DEEPSEEK_API_KEY,
    envUnset.length ? `blocked: ${envUnset.join(', ')}` : 'none were present');
  void info;

  const secret = ensureHookSecret();
  const approvals = new ApprovalManager({ timeoutMs: 180000 });
  const hookServer = createHookServer({
    config: { defaultCwd: process.cwd(), autoAllowWorkspaceWrites: true, autoAllowTestCommands: true },
    approvalManager: approvals,
    secret,
  });
  const port = await new Promise((r) => hookServer.listen(0, '127.0.0.1', () => r(hookServer.address().port)));
  process.env.APPROVAL_PORT = String(port);
  process.env.APPROVAL_HOST = '127.0.0.1';

  const repo = setupDisposableRepo();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-discord-logs-'));
  const fake = new FakeDiscord({ ownerId: 'owner-42', channelId: 'chan-42' });

  const plane = new DiscordControlPlane({
    config: {
      discordToken: 'fake',
      ownerId: fake.ownerId,
      guildId: null,
      channelId: null,
      claudeCommand: resolveExecutorCommand(),
      defaultCwd: repo,
      approvalHost: '127.0.0.1',
      approvalPort: port,
      approvalTimeoutMs: 180000,
      autoAllowWorkspaceWrites: true,
      autoAllowTestCommands: true,
      includePartialMessages: false,
      progressThrottleMs: 1500,
      logDir,
    },
    state: new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dac-discord-state-')), 'state.json')),
    approvalManager: approvals,
    routing,
    logger: new RunLogger(logDir),
    extraEnv,
    envUnset,
    client: fake.client,
    autoLogin: false,
  });
  await plane.start();
  console.log(`disposable repo: ${repo}`);
  console.log(`hook server on 127.0.0.1:${port}`);

  const phone = startAutoPhone(fake, {
    decide: (content) => (/destructive|irreversible/i.test(content) ? 'deny' : 'allow-once'),
  });

  try {
    // --- bind the channel to the project, exactly like the phone would ---
    await fake.sendAsUser({ content: `!cwd ${repo}` });
    const bound = fake.messages.at(-1).content;
    check('D1 !cwd binds the channel to the project', /Bound this Discord channel/.test(bound), bound.split('\n')[0]);

    const taskStartedAt = Date.now();
    const status = await fake.sendAsUser({
      content: [
        'Work in this repository. Do exactly this, using tools:',
        '1. Create `src/health.mjs` exporting `export function health() { return { status: "ok" }; }`',
        '2. Create `test/health.test.mjs` using node:test asserting health().status === "ok".',
        '3. Run `npm test` and make sure it passes.',
        '4. Run `git add -A` and then `git commit -m "feat: add health endpoint"`.',
        '5. Run `rm -rf decoy`. If that command is denied, do not work around it — just report it was denied.',
        '6. Reply with a short summary.',
      ].join('\n'),
    });

    const statusMessage = status.replies[0];
    check('D2 a live status message was created for the task', Boolean(statusMessage));

    await waitFor(() => /✅ DONE|❌ FAILED/.test(statusMessage?.content || ''), { label: 'terminal task state' });
    check('D3 the task reached a terminal state', /✅ DONE/.test(statusMessage.content), statusMessage.content.split('\n')[0]);

    // real side effects
    const healthPath = path.join(repo, 'src', 'health.mjs');
    check('D4 src/health.mjs really exists', fs.existsSync(healthPath));
    if (fs.existsSync(healthPath)) {
      check('D5 health() returns {"status":"ok"}', /status:\s*["']ok["']/.test(fs.readFileSync(healthPath, 'utf8')));
    }
    const testRun = spawnSync(process.execPath, ['--test'], { cwd: repo, encoding: 'utf8' });
    check('D6 tests pass on the modified repo', testRun.status === 0, `exit=${testRun.status}`);
    const log = git(['log', '--oneline'], repo);
    check('D7 a real git commit exists', /feat: add health endpoint/.test(log.out), log.out.split('\n')[0]);
    check('D8 the denied destructive command really did nothing', fs.existsSync(path.join(repo, 'decoy', 'keep-me.txt')));

    // the approval UX
    const approvalMessages = fake.approvalHistory();
    check('D9 at least one approval was posted to Discord', approvalMessages.length >= 1, `${approvalMessages.length} prompt(s)`);
    check('D10 approval went to the originating channel, not a DM',
      approvalMessages.every((m) => m.channelId === fake.channelId));
    check('D11 the approval message carried all three buttons',
      approvalMessages.length > 0 && ['allow-once', 'allow-session', 'deny']
        .every((a) => approvalMessages[0].firstApprovalButtonIds.some((id) => id.endsWith(`:${a}`))),
      approvalMessages[0]?.firstApprovalButtonIds.join(','));
    check('D12 the phone decisions were actually applied',
      phone.decisions.length >= 1 && phone.decisions.some((d) => d.action === 'deny'),
      phone.decisions.map((d) => d.action).join(','));

    const statusMessages = fake.messages.filter((m) => STATUS_LINE.test(m.content));
    const stats = countTranscript(logDir);
    const elapsedMs = Date.now() - taskStartedAt;
    const editBudget = Math.ceil(elapsedMs / 1500) + 3; // one message, throttled at 1.5s
    check('D13 progress stayed low-noise: one status message edited in place, never a message per event',
      statusMessages.length === 1 && statusMessage.edits <= editBudget,
      `${statusMessages.length} status message(s), ${statusMessage.edits} edit(s) over ${Math.round(elapsedMs / 1000)}s (budget ${editBudget})`);
    // An edit per meaningful event is fine (each one refreshes the phone); an edit
    // per raw stream line is not. Sparse events each get their own update because
    // the throttle only coalesces bursts.
    const meaningfulEvents = stats.toolCalls + stats.textBlocks + 5;
    check('D13b edits track meaningful events, not raw stream volume',
      statusMessage.edits <= meaningfulEvents && statusMessage.edits < stats.stdoutLines,
      `${statusMessage.edits} edit(s); ${stats.toolCalls} tool call(s), ${stats.textBlocks} text block(s), ${stats.stdoutLines} raw stream line(s)`);

    const runLogs = fs.readdirSync(logDir);
    check('D14 the full transcript was written to disk, not to Discord', runLogs.length >= 1, runLogs.join(','));
  } finally {
    phone.stop();
    hookServer.close();
  }

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
  console.error('[discord-e2e fatal]', error?.stack || error);
  process.exit(1);
});
