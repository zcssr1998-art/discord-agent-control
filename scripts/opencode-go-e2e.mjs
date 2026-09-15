/**
 * Real OpenCode Go verification and end-to-end run.
 *
 * Stage 1 fetches the live model list through the production ProviderManager and
 * reports how many models were found and how they map to transports. It never
 * prints the credential.
 *
 * Stage 2 runs the real Claude Code CLI against OpenCode Go through the
 * production ExecutorManager on a throwaway git repository, and asserts on real
 * side effects: a created file, its content, and a real `git status --short`.
 *
 * Usage: node scripts/opencode-go-e2e.mjs [model]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProviderManager, PROTOCOL, TRANSPORT } from '../src/provider-manager.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { ClaudeRunner } from '../src/claude-runner.mjs';
import { resolveExecutorCommand } from '../src/backend.mjs';
import { redactSecrets } from '../src/secrets.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const MODEL = process.argv[2] || 'minimax-m3';
const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function stageModels() {
  const credentials = new CredentialStore(path.join(root, 'data', 'credentials.json'));
  const providers = new ProviderManager({
    file: path.join(root, 'data', 'providers.json'),
    credentialStore: credentials,
  });
  const profile = providers.get('opencode-go');
  check('OpenCode Go is a built-in provider', profile?.protocol === PROTOCOL.OPENCODE_GO);
  check('OpenCode Go credential exists in the local store', providers.hasCredential(profile));

  const result = await providers.listModels('opencode-go', { force: true });
  const counts = {};
  for (const model of result.models) counts[model.transport] = (counts[model.transport] || 0) + 1;
  console.log(`discovered ${result.models.length} model(s): ${JSON.stringify(counts)}`);
  check('live models API returned models', result.models.length > 0, `${result.models.length} models`);
  check('every model carries a transport', result.models.every((model) => Boolean(model.transport)));

  const target = result.models.find((model) => model.id === MODEL);
  check(`requested model "${MODEL}" is in the live list`, Boolean(target));
  check(`"${MODEL}" is Claude Code compatible (anthropic-messages)`, target?.transport === TRANSPORT.ANTHROPIC_MESSAGES, target?.transport);
  return { providers, credentials, profile };
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-e2e-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# disposable\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: init'], { cwd: dir });
  return dir;
}

async function stageRun(profile) {
  const executors = new ExecutorManager({ workbuddyCommand: resolveExecutorCommand(process.env.CLAUDE_COMMAND) });
  await executors.discover();
  const executor = executors.get('claude');
  check('Claude Code executor is PASS', executor?.status === 'PASS', executor?.version);
  check('Claude Code is compatible with the OpenCode Go model', executors.compatible('claude', PROTOCOL.OPENCODE_GO, TRANSPORT.ANTHROPIC_MESSAGES));

  const { env, envUnset } = executors.buildEnvironment('claude', profile, 'PLACEHOLDER', MODEL, TRANSPORT.ANTHROPIC_MESSAGES);
  const foreign = ['OPENAI_API_KEY', 'DISCORD_TOKEN', 'ANTHROPIC_AUTH_TOKEN'].filter((name) => env[name] !== undefined);
  check('OpenCode Go child env carries no foreign credential', foreign.length === 0, foreign.join(',') || 'clean');
  check('OpenCode Go child env uses x-api-key (no Bearer token)', env.ANTHROPIC_API_KEY === 'PLACEHOLDER' && env.ANTHROPIC_AUTH_TOKEN === undefined);

  const dir = makeRepo();
  const credentials = new CredentialStore(path.join(root, 'data', 'credentials.json'));
  const credential = credentials.get(profile.credentialRef);
  const built = executors.buildEnvironment('claude', profile, credential, MODEL, TRANSPORT.ANTHROPIC_MESSAGES);

  // The Claude Code global PreToolUse hook fails closed, so the real approval
  // service must be running exactly as the bridge runs it. PermissionManager is
  // the real one; the presenter answers every prompt with "allow once" because
  // this harness has no phone. With STANDARD permissions a Write/Read/git status
  // task should need no prompt at all.
  const approvals = new ApprovalManager({ timeoutMs: 30000 });
  const permissions = new PermissionManager();
  const prompts = [];
  approvals.setPresenter((req) => {
    prompts.push(`${req.toolName}:${req.ruleKey}`);
    approvals.resolve(req.id, 'allow-once');
  });
  const secret = ensureHookSecret();
  const config = { defaultCwd: dir };
  const hookServer = createHookServer({ config, approvalManager: approvals, permissionManager: permissions, secret });
  await new Promise((resolve, reject) => {
    hookServer.once('error', reject);
    hookServer.listen(0, '127.0.0.1', resolve);
  });
  const port = hookServer.address().port;
  console.log(`approval service on 127.0.0.1:${port}`);

  let init = null;
  const runner = new ClaudeRunner({
    command: executor.command, cwd: dir, model: MODEL,
    extraEnv: { ...built.env, APPROVAL_HOST: '127.0.0.1', APPROVAL_PORT: String(port) },
    envUnset: built.envUnset, inheritEnv: false,
    onEvent: (event) => { if (event.type === 'init') init = event; },
  });

  const prompt = [
    '在当前目录创建文件 opencode-go-test.txt，内容为 OPENCODE_GO_OK。',
    '然后用 Read 读取该文件确认，再运行命令 git status --short。',
    '全部完成后只回复 DONE。',
  ].join('\n');

  try {
    const result = await runner.send(prompt);
    console.log(`\nmodel reported by CLI: ${init?.model}\napiKeySource: ${init?.apiKeySource}`);
    console.log(`tools: ${result.tools.map((tool) => tool.name).join(', ') || '(none)'}`);
    console.log(`approval prompts: ${prompts.join(', ') || '(none — all auto-allowed by PermissionManager)'}`);
    console.log(`final: ${redactSecrets(String(result.text || '').slice(0, 300))}`);
    check('Claude Code + OpenCode Go run completed', !result.isError);
    check('the request was served by the OpenCode Go credential', init?.apiKeySource === 'ANTHROPIC_API_KEY', init?.apiKeySource);
    check('a real tool call happened (Write/Read)', result.tools.some((tool) => /Write|Read/.test(tool.name)));
    check('PermissionManager auto-allowed the STANDARD task', prompts.length === 0, prompts.join(', '));
  } finally {
    await runner.stop({ reason: 'e2e complete' });
    hookServer.close();
  }

  const file = path.join(dir, 'opencode-go-test.txt');
  const exists = fs.existsSync(file);
  check('opencode-go-test.txt really exists on disk', exists);
  check('its content is OPENCODE_GO_OK', exists && fs.readFileSync(file, 'utf8').trim() === 'OPENCODE_GO_OK');
  const status = execFileSync('git', ['status', '--short'], { cwd: dir }).toString().trim();
  console.log(`\ngit status --short:\n${status}`);
  check('git status --short sees the new file', status.includes('opencode-go-test.txt'));
  console.log(`\nrepo: ${dir}`);
}

async function main() {
  const { profile } = await stageModels();
  await stageRun(profile);
  const failed = checks.filter((item) => !item.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(redactSecrets(error?.stack || String(error)));
  process.exitCode = 1;
});
