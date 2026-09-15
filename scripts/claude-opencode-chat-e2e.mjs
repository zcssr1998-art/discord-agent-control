/**
 * Real end-to-end: Claude Code (unchanged agent harness) -> local protocol
 * adapter -> OpenCode Go openai-chat -> DeepSeek / GLM -> real tools.
 *
 * Proves, per model:
 *  - Claude Code really starts and stays the agent loop (Write/Read/Bash tools);
 *  - the local adapter translates Anthropic <-> OpenAI chat;
 *  - the upstream request model field equals the selected model (no swap);
 *  - the OpenCode Go key never enters the Claude Code child environment;
 *  - PermissionManager (STANDARD) still gates the run;
 *  - real files and a real `git status --short` happen on disk.
 *
 * Usage: node scripts/claude-opencode-chat-e2e.mjs [model ...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CredentialStore } from '../src/credential-store.mjs';
import { ProviderManager, TRANSPORT, openCodeGoTransport } from '../src/provider-manager.mjs';
import { ExecutorManager } from '../src/executor-manager.mjs';
import { resolveExecutorCommand } from '../src/backend.mjs';
import { redactSecrets } from '../src/secrets.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { PermissionManager } from '../src/permission-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek-v4.1-flash', 'glm-5.3-flash'];

const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-chat-e2e-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# disposable\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: init'], { cwd: dir });
  return dir;
}

async function runModel({ executors, profile, credential, model, file, content }) {
  console.log(`\n===== ${model} =====`);
  const transport = openCodeGoTransport(model);
  check(`${model}: transport is openai-chat (needs adapter)`, transport === TRANSPORT.OPENAI_CHAT, transport);
  check(`${model}: Claude Code is compatible`, executors.compatible('claude', profile.protocol, transport));

  const dir = makeRepo();
  const approvals = new ApprovalManager({ timeoutMs: 30000 });
  const permissions = new PermissionManager();
  const prompts = [];
  approvals.setPresenter((req) => { prompts.push(`${req.toolName}:${req.ruleKey}`); approvals.resolve(req.id, 'allow-once'); });
  const hookServer = createHookServer({ config: { defaultCwd: dir }, approvalManager: approvals, permissionManager: permissions, secret: ensureHookSecret() });
  await new Promise((resolve, reject) => { hookServer.once('error', reject); hookServer.listen(0, '127.0.0.1', resolve); });
  const port = hookServer.address().port;

  let init = null;
  const runner = await executors.createRunner({
    executorId: 'claude', provider: profile, credential, model, cwd: dir,
    includePartialMessages: false,
    onEvent: (event) => { if (event.type === 'init') init = event; },
  });
  runner.extraEnv.APPROVAL_HOST = '127.0.0.1';
  runner.extraEnv.APPROVAL_PORT = String(port);

  check(`${model}: routed through the local adapter`, runner.adapter === 'anthropic-to-openai-chat');
  check(`${model}: child uses the local token, not the real key`,
    runner.extraEnv.ANTHROPIC_API_KEY === runner.gateway.token && runner.extraEnv.ANTHROPIC_API_KEY !== credential);
  check(`${model}: child env has no foreign credential`,
    runner.extraEnv.OPENAI_API_KEY === undefined && runner.extraEnv.DISCORD_TOKEN === undefined && runner.extraEnv.ANTHROPIC_AUTH_TOKEN === undefined);
  check(`${model}: ANTHROPIC_BASE_URL points at 127.0.0.1`, /^http:\/\/127\.0\.0\.1:\d+$/.test(runner.extraEnv.ANTHROPIC_BASE_URL), runner.extraEnv.ANTHROPIC_BASE_URL);

  const prompt = [
    `在当前目录创建文件 ${file}，内容为 ${content}。`,
    '然后用 Read 读取该文件确认，再运行命令 git status --short。',
    '全部完成后只回复 DONE。',
  ].join('\n');

  try {
    const result = await runner.send(prompt);
    const upstreamModels = runner.gateway.upstreamRequests.map((request) => request.model);
    console.log(`CLI model=${init?.model} apiKeySource=${init?.apiKeySource}`);
    console.log(`tools=${result.tools.map((tool) => tool.name).join(', ') || '(none)'}`);
    console.log(`upstream models=${JSON.stringify(upstreamModels)} prompts=${prompts.join(', ') || '(none)'}`);
    console.log(`final=${redactSecrets(String(result.text || '').slice(0, 200))}`);

    check(`${model}: run completed`, !result.isError);
    check(`${model}: served by the OpenCode Go credential`, init?.apiKeySource === 'ANTHROPIC_API_KEY', init?.apiKeySource);
    check(`${model}: real tool calls happened`, result.tools.some((tool) => /Write|Read/.test(tool.name)));
    check(`${model}: upstream model field is not swapped`,
      upstreamModels.length > 0 && upstreamModels.every((value) => value === model), JSON.stringify(upstreamModels));
    check(`${model}: PermissionManager allowed the STANDARD task without prompts`, prompts.length === 0, prompts.join(', '));
  } finally {
    await runner.stop({ reason: 'e2e complete' });
    hookServer.close();
  }

  const target = path.join(dir, file);
  const exists = fs.existsSync(target);
  check(`${model}: ${file} exists`, exists);
  check(`${model}: content is ${content}`, exists && fs.readFileSync(target, 'utf8').trim() === content);
  const status = execFileSync('git', ['status', '--short'], { cwd: dir }).toString().trim();
  console.log(`git status --short: ${status.replace(/\n/g, ' | ')}`);
  check(`${model}: git status --short sees the file`, status.includes(file));
  console.log(`repo: ${dir}`);
}

async function main() {
  const credentials = new CredentialStore(path.join(root, 'data', 'credentials.json'));
  const providers = new ProviderManager({ file: path.join(root, 'data', 'providers.json'), credentialStore: credentials });
  const profile = providers.get('opencode-go');
  const credential = credentials.get(profile.credentialRef);
  check('OpenCode Go credential is available', Boolean(credential));

  const executors = new ExecutorManager({ workbuddyCommand: resolveExecutorCommand(process.env.CLAUDE_COMMAND) });
  await executors.discover();
  check('Claude Code executor is PASS', executors.get('claude')?.status === 'PASS', executors.get('claude')?.version);

  for (const model of MODELS) await runModel({ executors, profile, credential, model, file: `claude-${model.startsWith('deepseek') ? 'ds' : 'glm'}-test.txt`, content: `${model.startsWith('deepseek') ? 'CLAUDE_DS_OK' : 'CLAUDE_GLM_OK'}` });

  const failed = checks.filter((item) => !item.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map((item) => item.label).join(' | ')); process.exitCode = 1; }
}

main().catch((error) => {
  console.error(redactSecrets(error?.stack || String(error)));
  process.exitCode = 1;
});
