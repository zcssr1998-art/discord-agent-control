import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Global Claude hook can stay installed without affecting normal local Claude Code.
// It only gates tool calls when the Discord bridge deliberately sets this env var.
if (process.env.DISCORD_BRIDGE_ACTIVE !== '1') process.exit(0);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const defaultSecretPath = path.join(root, 'data', 'hook-secret');
const secretPath = process.env.DISCORD_BRIDGE_SECRET_FILE || defaultSecretPath;
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

// The bridge injects DISCORD_BRIDGE_SECRET into the agent child environment, so
// the hook always uses the secret of the bridge that actually launched it. The
// file is only a fallback: a globally installed hook can live in a different
// checkout, whose data/hook-secret would otherwise be stale and cause HTTP 401.
const envSecret = String(process.env.DISCORD_BRIDGE_SECRET || '').trim();
let secret = envSecret;
if (!secret) {
  try { secret = fs.readFileSync(secretPath, 'utf8').trim(); }
  catch { deny('Discord approval bridge secret unavailable; failing closed.'); process.exit(0); }
}
if (!secret) { deny('Discord approval bridge secret is empty; failing closed.'); process.exit(0); }

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
