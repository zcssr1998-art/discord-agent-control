import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Global Claude hook can stay installed without affecting normal local Claude Code.
// It only gates tool calls when the Discord bridge deliberately sets this env var.
if (process.env.DISCORD_BRIDGE_ACTIVE !== '1') process.exit(0);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const secretPath = path.join(root, 'data', 'hook-secret');
const host = process.env.APPROVAL_HOST || '127.0.0.1';
const port = Number(process.env.APPROVAL_PORT || 37911);

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

let secret;
try { secret = fs.readFileSync(secretPath, 'utf8').trim(); }
catch { deny('Discord approval bridge secret unavailable; failing closed.'); process.exit(0); }

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const res = await fetch(`http://${host}:${port}/pre-tool-use`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: input,
    signal: AbortSignal.timeout(550000),
  });
  if (!res.ok) {
    deny(`Discord approval bridge returned HTTP ${res.status}; failing closed.`);
  } else {
    process.stdout.write(await res.text());
  }
} catch (error) {
  deny(`Discord approval bridge unreachable; failing closed: ${error.message}`);
}
