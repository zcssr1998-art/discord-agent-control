import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS = {
  claude: ['.claude', 'settings.json'],
  codebuddy: ['.codebuddy', 'settings.json'],
};
const HOOK_MARKER = 'approval-hook.mjs';
// Unique ownership marker appended to our hook command. It keeps unrelated
// projects that also ship a file called approval-hook.mjs from being removed.
const OWNER_FLAG = '--jarvis';
const STATUS_MESSAGE = 'Waiting for Discord approval when required';

function writeBomless(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Node writes UTF-8 without a BOM. A BOM makes the settings file invalid JSON
  // for strict parsers, which would silently disable the hook (see AGENTS.md).
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Only hooks that are provably ours are ever replaced:
 *   - current installs carry the `--jarvis` ownership flag, or
 *   - legacy installs (before the flag existed) carry our exact status text.
 * A foreign `approval-hook.mjs` with neither is preserved.
 */
function isJarvisHook(hook) {
  const command = String(hook?.command || '');
  if (!command.includes(HOOK_MARKER)) return false;
  if (new RegExp(`\\s${OWNER_FLAG}(\\s|"|$)`).test(command)) return true;
  return String(hook?.statusMessage || '') === STATUS_MESSAGE;
}

function upsertHook(settings, command) {
  const original = settings && typeof settings === 'object' ? settings : {};
  const next = { ...original };
  next.hooks = next.hooks && typeof next.hooks === 'object' ? { ...next.hooks } : {};
  const existing = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const entry = {
    hooks: [{
      type: 'command',
      command,
      timeout: 600,
      statusMessage: STATUS_MESSAGE,
    }],
  };

  const seen = new Set();
  const kept = [];
  for (const group of existing) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    // Drop only hooks we own, so a moved checkout cannot remain and a foreign
    // project's approval-hook.mjs is left untouched.
    const foreign = hooks.filter((hook) => !isJarvisHook(hook));
    for (const hook of foreign) seen.add(String(hook?.command || ''));
    if (foreign.length) kept.push({ ...group, hooks: foreign });
  }
  if (!seen.has(command)) kept.push(entry);
  next.hooks.PreToolUse = kept;

  return { settings: next, changed: JSON.stringify(next) !== JSON.stringify(original) };
}

/**
 * Make sure the user-level agent settings run THIS checkout's approval hook.
 *
 * A stale global hook (installed from a different repository path) makes every
 * tool call fail closed with HTTP 401, which is what happened when the project
 * was re-cloned. The bridge calls this on startup so the hook path always tracks
 * the running checkout. Only our own hook (ownership flag, or the legacy status
 * text) is replaced; every other hook is preserved. Ordinary sessions stay
 * unaffected because the hook is inert without DISCORD_BRIDGE_ACTIVE=1.
 */
export function ensureGlobalHook({ root, nodeExe = process.execPath, home = os.homedir(), logger = console } = {}) {
  const hookScript = path.join(root, 'scripts', HOOK_MARKER);
  const results = [];
  if (!fs.existsSync(hookScript)) {
    logger?.warn?.('[hook] approval-hook.mjs not found; global hook not installed');
    return { hookScript, results, installed: false };
  }
  const command = `"${nodeExe}" "${hookScript}" ${OWNER_FLAG}`;

  for (const [target, parts] of Object.entries(SETTINGS)) {
    const file = path.join(home, ...parts);
    let settings = {};
    if (fs.existsSync(file)) {
      try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch {
        logger?.warn?.(`[hook] ${file} is not valid JSON; leaving it untouched`);
        results.push({ target, file, changed: false, error: 'invalid-json' });
        continue;
      }
    }
    const { settings: next, changed } = upsertHook(settings, command);
    if (changed) writeBomless(file, JSON.stringify(next, null, 2));
    results.push({ target, file, changed });
  }
  return { hookScript, command, results, installed: true, changed: results.some((r) => r.changed) };
}
