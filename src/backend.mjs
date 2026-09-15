/**
 * Agent backend identity and paid-fallback guard.
 *
 * The bridge must be able to state, verifiably, which model backend actually
 * served a request, and it must refuse to silently fall back to a paid API.
 *
 * The WorkBuddy CodeBuddy CLI reports its credential origin in the
 * `system/init` event as `apiKeySource`. That is a machine-checkable fact, not a
 * guess, so it is what the bridge reports and gates on.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Credential variables that would route a request to a paid, metered API. */
export const PAID_CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MINIMAX_API_KEY',
  'ARK_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
];

/** Base URLs that would send traffic to a paid, metered endpoint. */
export const PAID_BASE_URL_VARS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
];

export const BACKEND = {
  WORKBUDDY: 'workbuddy-free-dsf',
  UNKNOWN: 'unknown',
};

/** Keyword that means "use the bundled WorkBuddy agent CLI". */
export const WORKBUDDY_COMMAND_KEYWORD = 'workbuddy';

/**
 * Locate the WorkBuddy agent CLI (a Claude Code compatible shell).
 *
 * `dist/codebuddy.js` is used rather than `bin/codebuddy` because it is a plain
 * `.js` entry: the runner already knows how to launch `.js` with the current
 * Node binary, whereas the extensionless launcher cannot be executed by cmd.exe.
 *
 * Returns null when nothing is found so the caller can report a clear error
 * instead of spawning nonsense.
 */
export function resolveWorkbuddyCli({ env = process.env, existsSync = fs.existsSync, platform = process.platform } = {}) {
  const relative = path.join('resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy.js');
  const candidates = [];
  if (env.WORKBUDDY_CLI) candidates.push(env.WORKBUDDY_CLI);
  const roots = [
    env.WORKBUDDY_HOME,
    platform === 'win32' ? 'D:\\WorkBuddy\\WorkBuddyAI' : null,
    platform === 'win32' ? 'C:\\Program Files\\WorkBuddy' : null,
    platform === 'win32' ? 'C:\\Program Files (x86)\\WorkBuddy' : null,
    platform === 'darwin' ? '/Applications/WorkBuddy.app/Contents' : null,
  ].filter(Boolean);
  for (const root of roots) candidates.push(path.join(root, relative));
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Remove every paid credential from a child environment.
 *
 * Names only are returned so callers can log what was blocked without ever
 * touching a value.
 */
export function stripPaidCredentials(env) {
  const removed = [];
  for (const name of [...PAID_CREDENTIAL_VARS, ...PAID_BASE_URL_VARS]) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Classify the backend from a `system/init` event.
 *
 * WorkBuddy routes through its own gateway, so `apiKeySource` mentions
 * workbuddy/codebuddy. Anything else means the request would have been served by
 * a third-party (paid) credential.
 */
export function classifyBackend(initEvent) {
  const source = String(initEvent?.apiKeySource ?? '').toLowerCase();
  const model = initEvent?.model ?? null;

  if (/workbuddy|codebuddy|genie/.test(source)) {
    return { id: BACKEND.WORKBUDDY, label: 'WorkBuddy Free DSF', apiKeySource: source, model, free: true };
  }
  if (!source) {
    return { id: BACKEND.UNKNOWN, label: 'unknown (no apiKeySource reported)', apiKeySource: null, model, free: false };
  }
  return { id: BACKEND.UNKNOWN, label: `unknown (${source})`, apiKeySource: source, model, free: false };
}

/** Human-readable billing route for the given backend classification. */
export function billingRoute(backend) {
  return backend?.free ? 'WorkBuddy Free' : 'UNCONFIRMED — possible paid route';
}

/**
 * Fail closed: decide whether a run may continue given the observed backend.
 *
 * Returns { ok, reason }. When paid fallback is disabled, anything other than
 * the WorkBuddy backend is refused rather than silently billed.
 */
export function assertBackendAllowed(backend, { allowPaidFallback = false, expected = BACKEND.WORKBUDDY } = {}) {
  if (allowPaidFallback) return { ok: true, reason: 'paid fallback allowed by configuration' };
  if (!backend) return { ok: false, reason: 'no backend information was reported by the agent' };
  if (backend.id === expected && backend.free) return { ok: true, reason: 'workbuddy free backend confirmed' };
  return {
    ok: false,
    reason: `expected backend "${expected}" but the agent reported "${backend.label}". `
      + 'Refusing to continue: paid fallback is disabled (set ALLOW_PAID_FALLBACK=true to override).',
  };
}

export function describeBackendLine(backend, { allowPaidFallback = false } = {}) {
  return [
    `Backend: ${backend?.label ?? 'unknown'}`,
    `Model: ${backend?.model ?? 'unknown'}`,
    `Billing route: ${billingRoute(backend)}`,
    `Paid fallback: ${allowPaidFallback ? 'ENABLED' : 'disabled'}`,
  ];
}

/**
 * Resolve the configured executor command, expanding the `workbuddy` keyword.
 *
 * Shared by the bridge, the smoke tests and the verification scripts so they all
 * exercise the same executor instead of each guessing.
 */
export function resolveExecutorCommand(raw = process.env.CLAUDE_COMMAND, opts = {}) {
  const value = String(raw ?? '').trim();
  if (!value || value === WORKBUDDY_COMMAND_KEYWORD) {
    const cli = resolveWorkbuddyCli(opts);
    if (cli) return cli;
    if (value === WORKBUDDY_COMMAND_KEYWORD) {
      throw new Error('CLAUDE_COMMAND=workbuddy but the WorkBuddy CLI was not found. Set WORKBUDDY_CLI to cli/dist/codebuddy.js.');
    }
  }
  return value || 'claude';
}

/**
 * Run the executor once with a trivial prompt and report which backend answered.
 *
 * This is the startup preflight: it makes "the free backend is unavailable" a
 * loud, immediate failure instead of a mysterious hang several minutes into a
 * task.
 */
export async function probeBackend({ command, cwd, extraEnv = {}, envUnset = [], inheritEnv = true, timeoutMs = 180000, prompt = 'Reply with exactly: OK' }) {
  const { ClaudeRunner } = await import('./claude-runner.mjs');
  const { withTimeout } = await import('./limits.mjs');

  let init = null;
  const runner = new ClaudeRunner({
    command,
    cwd,
    extraEnv,
    envUnset,
    inheritEnv,
    onEvent: (event) => { if (event.type === 'init') init = event; },
  });

  try {
    const result = await withTimeout(runner.send(prompt), timeoutMs, {
      onTimeout: () => runner.stop(),
      label: 'backend probe',
    });
    return {
      ok: !result.isError,
      backend: classifyBackend({ apiKeySource: init?.apiKeySource, model: init?.model }),
      text: result.text,
      durationMs: result.durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      backend: classifyBackend({ apiKeySource: init?.apiKeySource, model: init?.model }),
      error: String(error?.message || error),
    };
  } finally {
    await runner.stop();
  }
}
