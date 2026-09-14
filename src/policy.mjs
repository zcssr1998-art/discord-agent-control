import path from 'node:path';
import fs from 'node:fs';

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

const SENSITIVE_PATH_PATTERNS = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gh([\\/]|$)/i,
  /credentials?/i,
  /secrets?/i,
  /id_(rsa|ed25519)/i,
];

const DESTRUCTIVE_BASH = [
  /(^|[;&|]\s*)rm\s+-/i,
  /\bdel\s+\/([fq]|s)/i,
  /\brmdir\s+\/s/i,
  /\bremove-item\b.*-(recurse|force)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-|push\b|rebase\b)/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bshutdown\b/i,
  /\bsc\s+(delete|stop)\b/i,
];

const NETWORK_BASH = [
  /\b(curl|wget|Invoke-WebRequest|iwr|ssh|scp|sftp)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|add|publish)\b/i,
  /\b(pip|pip3)\s+install\b/i,
  /\b(choco|winget|scoop)\s+(install|uninstall|upgrade)\b/i,
];

const SAFE_BASH = [
  /^\s*(pwd|cd\s+[^;&|]+|dir|ls(?:\s|$)|where\s+|which\s+)/i,
  // Local, reversible git work. `git push`, `reset --hard`, `clean` and `rebase`
  // are matched by DESTRUCTIVE_BASH first, so they stay gated.
  /^\s*git\s+(status|diff|log|show|branch|add|commit|rev-parse|ls-files|describe|blame|shortlog)\b/i,
  /^\s*git\s+(checkout\s+-b|switch\s+-c)\s+\S+/i,
  /^\s*git\s+(remote\s+-v|tag(?:\s+-l)?|stash\s+list)\s*$/i,
  /^\s*(rg|grep|findstr|type|cat|Get-Content)\b/i,
  /^\s*(node|npm|pnpm|yarn)\s+(--version|-v)\s*$/i,
];

const TEST_BASH = [
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+(test|lint|check|build))\b/i,
  /^\s*(pytest|python\s+-m\s+pytest|dotnet\s+test|cargo\s+test|go\s+test)\b/i,
];

const canonicalCache = new Map();

/**
 * Resolve to a canonical absolute path.
 *
 * Windows can spell the same directory two ways: the long form and the 8.3 short
 * form (`C:\Users\ADMINI~1.DES\...`, which is what `os.tmpdir()` returns on some
 * machines). If `cwd` and the tool's target path use different spellings, a plain
 * prefix check classifies every in-workspace edit as "write outside workspace" and
 * the user gets an approval prompt for every single edit. `realpathSync.native`
 * expands short names; for paths that do not exist yet we canonicalise the nearest
 * existing ancestor and re-append the remainder.
 */
function canonical(p) {
  const abs = path.resolve(p);
  const cached = canonicalCache.get(abs);
  if (cached !== undefined) return cached;

  let result = abs;
  try {
    result = fs.realpathSync.native(abs);
  } catch {
    const parts = [];
    let dir = abs;
    for (;;) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      parts.unshift(path.basename(dir));
      dir = parent;
      try {
        result = path.join(fs.realpathSync.native(dir), ...parts);
        break;
      } catch { /* keep walking up */ }
    }
  }
  if (canonicalCache.size > 500) canonicalCache.clear();
  canonicalCache.set(abs, result);
  return result;
}

function normalize(p) {
  return canonical(p).toLowerCase();
}

/** True for commands the policy treats as "run the project's own checks". */
export function isTestCommand(command) {
  return TEST_BASH.some((re) => re.test(String(command || '')));
}

/** True when the tool name is one of the project's own test runners. */
export function isTestToolName(toolName) {
  return /^(pytest|jest|vitest)$/i.test(String(toolName || ''));
}

function inside(root, candidate) {
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(r + path.sep.toLowerCase());
}

function filePathFromInput(input = {}) {
  return input.file_path || input.path || input.notebook_path || null;
}

export function classifyToolCall({ toolName, toolInput = {}, cwd, config }) {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'read-only tool', ruleKey: 'read-only' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = filePathFromInput(toolInput);
    if (!p) return { decision: 'ask', reason: 'write target unknown', ruleKey: 'write-unknown' };
    const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(absolute))) {
      return { decision: 'ask', reason: `sensitive file: ${absolute}`, ruleKey: 'write-sensitive' };
    }
    if (!inside(cwd, absolute)) {
      return { decision: 'ask', reason: `write outside workspace: ${absolute}`, ruleKey: 'write-outside' };
    }
    if (config.autoAllowWorkspaceWrites) {
      return { decision: 'allow', reason: 'workspace write', ruleKey: 'write-workspace' };
    }
    return { decision: 'ask', reason: `workspace write: ${absolute}`, ruleKey: 'write-workspace' };
  }

  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');
    if (!command) return { decision: 'ask', reason: 'shell command missing', ruleKey: 'bash-unknown' };
    if (DESTRUCTIVE_BASH.some((re) => re.test(command))) {
      return { decision: 'ask', reason: 'destructive or irreversible shell command', ruleKey: 'bash-destructive' };
    }
    if (NETWORK_BASH.some((re) => re.test(command))) {
      return { decision: 'ask', reason: 'network/install/publish shell command', ruleKey: 'bash-network' };
    }
    if (SAFE_BASH.some((re) => re.test(command))) {
      return { decision: 'allow', reason: 'read-only shell command', ruleKey: 'bash-read' };
    }
    if (config.autoAllowTestCommands && TEST_BASH.some((re) => re.test(command))) {
      return { decision: 'allow', reason: 'test/build command', ruleKey: 'bash-test' };
    }
    return { decision: 'ask', reason: 'unclassified shell command', ruleKey: 'bash-other' };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    return { decision: 'ask', reason: 'network access', ruleKey: 'network' };
  }

  if (toolName === 'Agent' || toolName === 'Task') {
    return { decision: 'allow', reason: 'subagent orchestration', ruleKey: 'subagent' };
  }

  if (toolName?.startsWith('mcp__')) {
    return { decision: 'ask', reason: 'MCP action', ruleKey: `mcp:${toolName.split('__').slice(0, 2).join('__')}` };
  }

  return { decision: 'ask', reason: `unknown tool: ${toolName}`, ruleKey: `unknown:${toolName || 'none'}` };
}
