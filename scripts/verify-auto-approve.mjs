#!/usr/bin/env node
/**
 * Verify AUTO_APPROVE_ALL bypasses every gate without Discord messages.
 */
import { classifyToolCall } from '../src/policy.mjs';
import { ApprovalManager } from '../src/approval-manager.mjs';
import { createHookServer, ensureHookSecret } from '../src/hook-server.mjs';
import http from 'node:http';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ------------------------------------------------------------------
// 1. Policy: every tool is auto-allowed when autoApproveAll=true
// ------------------------------------------------------------------
const configOn = { autoApproveAll: true, autoAllowWorkspaceWrites: false, autoAllowTestCommands: false };
const configOff = { autoApproveAll: false, autoAllowWorkspaceWrites: true, autoAllowTestCommands: true };

const riskyCalls = [
  { toolName: 'Bash', toolInput: { command: 'rm -rf /important' }, desc: 'destructive bash' },
  { toolName: 'Bash', toolInput: { command: 'curl -s https://example.com' }, desc: 'network bash' },
  { toolName: 'Bash', toolInput: { command: 'git push origin main' }, desc: 'git push' },
  { toolName: 'Write', toolInput: { file_path: 'C:/Windows/system32/evil.dll' }, desc: 'write outside workspace' },
  { toolName: 'Edit', toolInput: { file_path: '/etc/passwd' }, desc: 'edit sensitive path' },
  { toolName: 'WebFetch', toolInput: { url: 'https://example.com' }, desc: 'WebFetch' },
  { toolName: 'WebSearch', toolInput: { query: 'anything' }, desc: 'WebSearch' },
  { toolName: 'mcp__dangerous__thing', toolInput: {}, desc: 'MCP tool' },
];

for (const { toolName, toolInput, desc } of riskyCalls) {
  const on = classifyToolCall({ toolName, toolInput, cwd: process.cwd(), config: configOn });
  check(`policy ON: ${desc} -> allow`, on.decision === 'allow', `${on.decision} (${on.reason})`);
}

// Verify normal gating still works when OFF
const offDestructive = classifyToolCall({ toolName: 'Bash', toolInput: { command: 'rm -rf /' }, cwd: process.cwd(), config: configOff });
check('policy OFF: destructive still asks', offDestructive.decision === 'ask', offDestructive.decision);

const offNetwork = classifyToolCall({ toolName: 'Bash', toolInput: { command: 'curl https://x.com' }, cwd: process.cwd(), config: configOff });
check('policy OFF: network still asks', offNetwork.decision === 'ask', offNetwork.decision);

// ------------------------------------------------------------------
// 2. ApprovalManager: auto-approves immediately, no presenter needed
// ------------------------------------------------------------------
const mgrOn = new ApprovalManager({ timeoutMs: 5000, config: configOn });
let presenterCalled = false;
mgrOn.setPresenter(() => { presenterCalled = true; });

const answerOn = await mgrOn.request({ sessionId: 's1', ruleKey: 'bash-destructive', toolName: 'Bash', reason: 'test' });
check('manager ON: returns allow without presenter', answerOn.decision === 'allow', answerOn.decision);
check('manager ON: presenter was NOT called', !presenterCalled, `called=${presenterCalled}`);
check('manager ON: reason is AUTO_APPROVE_ALL', answerOn.reason === 'AUTO_APPROVE_ALL', answerOn.reason);

const mgrOff = new ApprovalManager({ timeoutMs: 5000, config: configOff });
let presenterCalledOff = false;
mgrOff.setPresenter(() => { presenterCalledOff = true; });
// This would normally hang because presenter doesn't resolve, so give it a quick timeout
const answerOffPromise = mgrOff.request({ sessionId: 's2', ruleKey: 'bash-destructive', toolName: 'Bash', reason: 'test' });
await new Promise((r) => setTimeout(r, 100));
check('manager OFF: presenter WAS called', presenterCalledOff, `called=${presenterCalledOff}`);
mgrOff.cancelForSession('s2'); // clean up

// ------------------------------------------------------------------
// 3. Hook server: real HTTP calls auto-allow every tool when ON
// ------------------------------------------------------------------
const secret = ensureHookSecret();
const hookConfig = { defaultCwd: process.cwd(), autoApproveAll: true, autoAllowWorkspaceWrites: false, autoAllowTestCommands: false };
const hookMgr = new ApprovalManager({ timeoutMs: 5000, config: hookConfig });
const server = createHookServer({ config: hookConfig, approvalManager: hookMgr, secret });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function hookReq(payload) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/pre-tool-use', method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(JSON.stringify(payload));
  });
}

const httpResults = await Promise.all([
  hookReq({ tool_name: 'Bash', tool_input: { command: 'Invoke-WebRequest https://evil.com' }, cwd: process.cwd(), session_id: 'http-1' }),
  hookReq({ tool_name: 'Write', tool_input: { file_path: 'C:/secret.txt' }, cwd: process.cwd(), session_id: 'http-1' }),
  hookReq({ tool_name: 'Edit', tool_input: { file_path: '/etc/shadow' }, cwd: process.cwd(), session_id: 'http-1' }),
  hookReq({ tool_name: 'WebSearch', tool_input: { query: 'exfil' }, cwd: process.cwd(), session_id: 'http-1' }),
  hookReq({ tool_name: 'mcp__bad', tool_input: {}, cwd: process.cwd(), session_id: 'http-1' }),
]);

for (let i = 0; i < httpResults.length; i++) {
  const r = httpResults[i];
  const name = ['PowerShell/network', 'Write outside workspace', 'Edit sensitive', 'WebSearch', 'MCP'][i];
  const decision = r.hookSpecificOutput?.permissionDecision;
  check(`hook ON: ${name} -> allow`, decision === 'allow', decision);
}

server.close();

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n=== summary ===');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const r of failed) console.log(` - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  process.exit(1);
}
console.log('\n【AUTO APPROVE】PASS');
