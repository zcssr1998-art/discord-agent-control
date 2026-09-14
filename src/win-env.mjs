import { spawn } from 'node:child_process';

/**
 * Environment variables that decide which model backend Claude Code actually talks to.
 *
 * The user's DeepSeek setup lives in the Windows *User* environment (written by
 * `~/claude-deepseek/use-deepseek-claude.ps1`). A process only inherits that
 * environment at creation time, so a bridge started from a long-lived shell can
 * end up with a stale (or empty) environment and silently fall back to the
 * official Anthropic endpoint. That failure mode is invisible in the Discord UI
 * and is exactly what the handover task calls out as unacceptable, so the bridge
 * verifies and repairs it at startup.
 */
export const ROUTING_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
];

const SECRET_VARS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);

export function describeRouting(env) {
  const model = env.ANTHROPIC_MODEL || '(unset)';
  const base = env.ANTHROPIC_BASE_URL || '(unset)';
  const hasToken = Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
  return { model, base, hasToken };
}

function psQuote(list) {
  return list.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
}

/**
 * Read the given variables from the Windows *User* environment (registry-backed)
 * via one non-interactive PowerShell call. Returns {} on any failure so callers
 * can degrade to "use whatever process.env already has".
 */
export function readWindowsUserEnv(names = ROUTING_VARS, { timeoutMs = 15000, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({});
  const script =
    `$names = @(${psQuote(names)}); ` +
    '$o = [ordered]@{}; ' +
    'foreach ($n in $names) { $v = [Environment]::GetEnvironmentVariable($n, "User"); if ($v) { $o[$n] = $v } }; ' +
    'ConvertTo-Json -InputObject $o -Compress';

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return done({});
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({}); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); done({}); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim() || '{}');
        done(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        done({});
      }
    });
  });
}

/**
 * Ensure the child Claude process gets the user's real provider routing.
 *
 * Fast path: the current process already has ANTHROPIC_BASE_URL -> nothing to do.
 * Slow path (Windows only): pull the values from the User environment once.
 *
 * Returns { env, source, added } where `env` is the extra environment to merge
 * into the child and `added` lists variable NAMES only (never values).
 */
export async function resolveRoutingEnv(baseEnv = process.env, opts = {}) {
  if (baseEnv.ANTHROPIC_BASE_URL) {
    return { env: {}, source: 'process-env', added: [] };
  }
  const readEnv = opts.readEnv || ((names) => readWindowsUserEnv(names, opts));
  const fromRegistry = await readEnv(ROUTING_VARS);
  const env = {};
  const added = [];
  for (const [k, v] of Object.entries(fromRegistry || {})) {
    if (v && !baseEnv[k]) {
      env[k] = v;
      added.push(k);
    }
  }
  if (!env.ANTHROPIC_BASE_URL) {
    return { env: {}, source: 'unavailable', added: [] };
  }
  return { env, source: 'windows-user-env', added };
}

export function redactForLog(env, keys = ROUTING_VARS) {
  const out = {};
  for (const k of keys) {
    if (env[k] == null) continue;
    out[k] = SECRET_VARS.has(k) ? `<set:${String(env[k]).length}>` : env[k];
  }
  return out;
}

/**
 * Normalise whatever Windows stores in `ProxyServer` into a URL Node can use.
 *
 * The registry value is either a bare `host:port` or a per-scheme list such as
 * `http=127.0.0.1:7890;https=127.0.0.1:7890`. Returns null when there is nothing
 * usable.
 */
export function normalizeProxyUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  let candidate = value;
  if (value.includes('=')) {
    const entries = new Map(
      value.split(';')
        .map((part) => part.split('='))
        .filter((pair) => pair.length === 2)
        .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
    );
    candidate = entries.get('https') || entries.get('http') || entries.get('socks') || '';
    if (!candidate) return null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return candidate;
  return `http://${candidate}`;
}

/**
 * Read the Windows system proxy (the same value the rest of the OS uses).
 *
 * Node ignores this completely, which is why a machine whose Clash/V2Ray runs in
 * system-proxy mode can reach Discord from every app except this one.
 */
export function readWindowsSystemProxy({ timeoutMs = 15000, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script =
    '$k = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"; ' +
    '$p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue; ' +
    'if ($p -and $p.ProxyEnable -eq 1 -and $p.ProxyServer) { Write-Output $p.ProxyServer }';

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('exit', () => { clearTimeout(timer); done(normalizeProxyUrl(out.trim())); });
  });
}

/**
 * Decide which proxy Discord should use.
 *
 *   DISCORD_PROXY unset        -> the Windows system proxy, if any
 *   DISCORD_PROXY=<url>        -> that proxy
 *   DISCORD_PROXY=off          -> no proxy (connect directly)
 */
export async function resolveDiscordProxy(explicit = process.env.DISCORD_PROXY, opts = {}) {
  const raw = String(explicit ?? '').trim();
  if (/^(off|none|direct|false|0)$/i.test(raw)) return { proxyUrl: null, source: 'disabled' };
  if (raw) return { proxyUrl: normalizeProxyUrl(raw), source: 'env' };

  const readSystem = opts.readSystemProxy || (() => readWindowsSystemProxy(opts));
  const system = await readSystem();
  if (system) return { proxyUrl: system, source: 'windows-system' };
  return { proxyUrl: null, source: 'none' };
}
