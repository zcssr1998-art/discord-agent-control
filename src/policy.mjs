import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'Shell', 'PowerShell']);

const SENSITIVE_PATH_PATTERNS = [
  /(^|[\\/])\.env($|\.)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.config[\\/]gh([\\/]|$)/i,
  /credentials?/i,
  /secrets?/i,
  /id_(rsa|ed25519)/i,
];

const DESTRUCTIVE_SHELL = [
  /(^|[;&|]\s*)rm\s+-/i,
  /\bdel\s+\/([fq]|s)/i,
  /\brmdir\s+\/s/i,
  /\bremove-item\b.*-(recurse|force)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-|rebase\b)/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bshutdown\b/i,
  /\bsc\s+(delete|stop)\b/i,
];

const SYSTEM_OR_CREDENTIAL_SHELL = [
  /\b(ssh|scp|sftp)\b/i,
  /\b(Set-ExecutionPolicy|Set-ItemProperty|New-Service|Set-Service)\b/i,
  /\b(reg\s+(add|import)|sc\s+(create|config)|bcdedit|mount|umount)\b/i,
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /\b(credentials?|secrets?|id_(rsa|ed25519))\b/i,
];

const NETWORK_SHELL = [
  /\b(curl|wget|Invoke-WebRequest|iwr)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|add|publish)\b/i,
  /\b(pip|pip3)\s+install\b/i,
  /\b(choco|winget|scoop)\s+(install|uninstall|upgrade)\b/i,
];

const READ_ONLY_SHELL = [
  /^\s*(pwd|cd\s+[^;&|]+|dir|ls(?:\s|$)|where\s+|which\s+)/i,
  /(^|[;&|]\s*)git\s+(status|diff|log|show|branch|rev-parse|ls-files|describe|blame|shortlog)\b/i,
  /(^|[;&|]\s*)git\s+(remote\s+-v|tag(?:\s+-l)?|stash\s+list)\s*$/i,
  /(^|[;&|]\s*)(rg|grep|findstr|type|cat|Get-Content|Get-ChildItem|Get-Item|Test-Path)\b/i,
  /(^|[;&|]\s*)(node|npm|pnpm|yarn)\s+(--version|-v)\s*$/i,
];

const STANDARD_GIT_SHELL = [
  /(^|[;&|]\s*)git\s+(add|commit)\b/i,
  /(^|[;&|]\s*)git\s+(checkout\s+-b|switch\s+-c)\s+\S+/i,
];

const TEST_SHELL = [
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+(test|lint|check|build))\b/i,
  /^\s*(pytest|python\s+-m\s+pytest|dotnet\s+test|cargo\s+test|go\s+test)\b/i,
];

const canonicalCache = new Map();

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

export function isTestCommand(command) {
  return TEST_SHELL.some((re) => re.test(String(command || '')));
}

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

function sensitivePath(value) {
  const candidate = String(value || '');
  if (!candidate || /(^|[\\/])\.env\.example$/i.test(candidate)) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(candidate));
}

function stagedSecretRisk(cwd) {
  const result = spawnSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status !== 0) return false;
  const added = String(result.stdout || '').split(/\r?\n/).filter((line) => /^\+(?!\+\+)/.test(line)).join('\n');
  return /(?:token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*["'][^"']{12,}["']/i.test(added)
    || /bearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(added);
}

function commandTouchesSensitivePath(command) {
  const tokens = String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.some((token) => sensitivePath(token.replace(/^["']|["']$/g, '')));
}

function secretGitRisk(command, cwd) {
  if (/\bgit\s+add\b/i.test(command) && commandTouchesSensitivePath(command)) return true;
  return /\bgit\s+commit\b/i.test(command) && stagedSecretRisk(cwd);
}

/**
 * 根据工具名、输入和权限档位决定是否需要审批。
 *
 * @param {string} permissionLevel - 'strict' | 'standard' | 'relaxed' | 'full'
 */
export function classifyToolCall({ toolName, toolInput = {}, cwd, permissionLevel = 'standard' }) {
  const targetPath = filePathFromInput(toolInput);
  if (targetPath && sensitivePath(targetPath)) {
    return { decision: 'ask', reason: 'sensitive file access', ruleKey: 'sensitive-file' };
  }

  const command = String(toolInput.command || '');
  if (SHELL_TOOLS.has(toolName) && secretGitRisk(command, cwd)) {
    return { decision: 'deny', reason: 'secret-like content must not be committed', ruleKey: 'secret-git' };
  }
  if (SHELL_TOOLS.has(toolName) && commandTouchesSensitivePath(command)) {
    return { decision: 'ask', reason: 'sensitive file access', ruleKey: 'sensitive-file' };
  }

  if (permissionLevel === 'full') return { decision: 'allow', reason: 'FULL mode', ruleKey: 'full' };

  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'read-only tool', ruleKey: 'read-only' };
  }

  if (toolName === 'Agent' || toolName === 'Task') {
    return { decision: 'allow', reason: 'subagent orchestration', ruleKey: 'subagent' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = filePathFromInput(toolInput);
    if (!p) return { decision: 'ask', reason: 'write target unknown', ruleKey: 'write-unknown' };
    const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    if (!inside(cwd, absolute)) {
      return { decision: 'ask', reason: `write outside workspace`, ruleKey: 'write-outside' };
    }
    // STRICT: 工作区写入也需审批
    if (permissionLevel === 'strict') {
      return { decision: 'ask', reason: 'workspace write (STRICT)', ruleKey: 'write-workspace' };
    }
    return { decision: 'allow', reason: 'workspace write', ruleKey: 'write-workspace' };
  }

  if (SHELL_TOOLS.has(toolName)) {
    if (!command) return { decision: 'ask', reason: 'shell command missing', ruleKey: 'bash-unknown' };

    if (DESTRUCTIVE_SHELL.some((re) => re.test(command))) {
      return { decision: 'ask', reason: 'destructive or irreversible shell command', ruleKey: 'bash-destructive' };
    }

    if (SYSTEM_OR_CREDENTIAL_SHELL.some((re) => re.test(command))) {
      return { decision: 'ask', reason: 'system, SSH, or credential access', ruleKey: 'bash-sensitive' };
    }

    // git push：RELAXED 自动通过
    if (/\bgit\s+push\b/i.test(command)) {
      if (permissionLevel === 'relaxed') {
        return { decision: 'allow', reason: 'git push', ruleKey: 'bash-push' };
      }
      return { decision: 'ask', reason: 'git push', ruleKey: 'bash-push' };
    }

    // 网络/安装命令
    if (NETWORK_SHELL.some((re) => re.test(command))) {
      if (permissionLevel === 'relaxed') {
        return { decision: 'allow', reason: 'network/install shell command', ruleKey: 'bash-network' };
      }
      return { decision: 'ask', reason: 'network/install/publish shell command', ruleKey: 'bash-network' };
    }

    if (READ_ONLY_SHELL.some((re) => re.test(command))) {
      return { decision: 'allow', reason: 'read-only shell command', ruleKey: 'bash-read' };
    }

    if (permissionLevel === 'strict') {
      const ruleKey = TEST_SHELL.some((re) => re.test(command)) ? 'bash-test' : 'bash-other';
      return { decision: 'ask', reason: 'shell command requires approval in STRICT', ruleKey };
    }

    if (TEST_SHELL.some((re) => re.test(command))) return { decision: 'allow', reason: 'test/build command', ruleKey: 'bash-test' };
    if (STANDARD_GIT_SHELL.some((re) => re.test(command))) return { decision: 'allow', reason: 'local git command', ruleKey: 'bash-git' };
    if (permissionLevel === 'relaxed') return { decision: 'allow', reason: 'ordinary shell command', ruleKey: 'bash-other' };
    return { decision: 'ask', reason: 'unclassified shell command', ruleKey: 'bash-other' };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    if (permissionLevel === 'relaxed') {
      return { decision: 'allow', reason: 'network access', ruleKey: 'network' };
    }
    return { decision: 'ask', reason: 'network access', ruleKey: 'network' };
  }

  if (isTestToolName(toolName)) {
    return permissionLevel === 'strict'
      ? { decision: 'ask', reason: 'test tool requires approval in STRICT', ruleKey: 'test-tool' }
      : { decision: 'allow', reason: 'test tool', ruleKey: 'test-tool' };
  }

  if (toolName?.startsWith('mcp__')) {
    return { decision: 'ask', reason: 'MCP action', ruleKey: `mcp:${toolName.split('__').slice(0, 2).join('__')}` };
  }

  return { decision: 'ask', reason: `unknown tool: ${toolName}`, ruleKey: `unknown:${toolName || 'none'}` };
}
