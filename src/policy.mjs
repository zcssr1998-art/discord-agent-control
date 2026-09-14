import path from 'node:path';
import fs from 'node:fs';

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.env($|\.)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.config[\\/]gh([\\/]|$)/i,
  /credentials?/i,
  /secrets?/i,
  /id_(rsa|ed25519)/i,
];

/** 真正不可逆/危险操作 — 所有模式（除 FULL）都审批。 */
const DESTRUCTIVE_BASH = [
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

const NETWORK_BASH = [
  /\b(curl|wget|Invoke-WebRequest|iwr|ssh|scp|sftp)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|add|publish)\b/i,
  /\b(pip|pip3)\s+install\b/i,
  /\b(choco|winget|scoop)\s+(install|uninstall|upgrade)\b/i,
];

const SAFE_BASH = [
  /^\s*(pwd|cd\s+[^;&|]+|dir|ls(?:\s|$)|where\s+|which\s+)/i,
  /(^|[;&|]\s*)git\s+(status|diff|log|show|branch|add|commit|rev-parse|ls-files|describe|blame|shortlog)\b/i,
  /(^|[;&|]\s*)git\s+(checkout\s+-b|switch\s+-c)\s+\S+/i,
  /(^|[;&|]\s*)git\s+(remote\s+-v|tag(?:\s+-l)?|stash\s+list)\s*$/i,
  /(^|[;&|]\s*)(rg|grep|findstr|type|cat|Get-Content)\b/i,
  /(^|[;&|]\s*)(node|npm|pnpm|yarn)\s+(--version|-v)\s*$/i,
];

const TEST_BASH = [
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
  return TEST_BASH.some((re) => re.test(String(command || '')));
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

/**
 * 根据工具名、输入和权限档位决定是否需要审批。
 *
 * @param {string} permissionLevel - 'strict' | 'standard' | 'relaxed' | 'full'
 */
export function classifyToolCall({ toolName, toolInput = {}, cwd, config, permissionLevel = 'standard' }) {
  // FULL: 所有工具自动通过（安全边界由 bridge 层维护）
  if (permissionLevel === 'full') {
    return { decision: 'allow', reason: 'FULL mode', ruleKey: 'full' };
  }

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
    if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(absolute))) {
      return { decision: 'ask', reason: `sensitive file`, ruleKey: 'write-sensitive' };
    }
    if (!inside(cwd, absolute)) {
      return { decision: 'ask', reason: `write outside workspace`, ruleKey: 'write-outside' };
    }
    // STRICT: 工作区写入也需审批
    if (permissionLevel === 'strict') {
      return { decision: 'ask', reason: 'workspace write (STRICT)', ruleKey: 'write-workspace' };
    }
    if (config.autoAllowWorkspaceWrites) {
      return { decision: 'allow', reason: 'workspace write', ruleKey: 'write-workspace' };
    }
    return { decision: 'ask', reason: `workspace write`, ruleKey: 'write-workspace' };
  }

  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');
    if (!command) return { decision: 'ask', reason: 'shell command missing', ruleKey: 'bash-unknown' };

    // 真正不可逆操作：所有非 FULL 模式都审批
    if (DESTRUCTIVE_BASH.some((re) => re.test(command))) {
      return { decision: 'ask', reason: 'destructive or irreversible shell command', ruleKey: 'bash-destructive' };
    }

    // git push：RELAXED 自动通过
    if (/\bgit\s+push\b/i.test(command)) {
      if (permissionLevel === 'relaxed') {
        return { decision: 'allow', reason: 'git push', ruleKey: 'bash-push' };
      }
      return { decision: 'ask', reason: 'git push', ruleKey: 'bash-push' };
    }

    // 网络/安装命令
    if (NETWORK_BASH.some((re) => re.test(command))) {
      if (permissionLevel === 'relaxed') {
        return { decision: 'allow', reason: 'network/install shell command', ruleKey: 'bash-network' };
      }
      return { decision: 'ask', reason: 'network/install/publish shell command', ruleKey: 'bash-network' };
    }

    // 安全命令：所有模式自动通过
    if (SAFE_BASH.some((re) => re.test(command))) {
      return { decision: 'allow', reason: 'read-only shell command', ruleKey: 'bash-read' };
    }

    // 测试命令
    if (TEST_BASH.some((re) => re.test(command))) {
      if (permissionLevel === 'strict') {
        return { decision: 'ask', reason: 'test command (STRICT)', ruleKey: 'bash-test' };
      }
      if (config.autoAllowTestCommands) {
        return { decision: 'allow', reason: 'test/build command', ruleKey: 'bash-test' };
      }
      return { decision: 'ask', reason: 'test/build command', ruleKey: 'bash-test' };
    }

    // 未分类命令
    if (permissionLevel === 'strict') {
      return { decision: 'ask', reason: 'unclassified shell command (STRICT)', ruleKey: 'bash-other' };
    }
    return { decision: 'ask', reason: 'unclassified shell command', ruleKey: 'bash-other' };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    if (permissionLevel === 'relaxed') {
      return { decision: 'allow', reason: 'network access', ruleKey: 'network' };
    }
    return { decision: 'ask', reason: 'network access', ruleKey: 'network' };
  }

  if (toolName?.startsWith('mcp__')) {
    return { decision: 'ask', reason: 'MCP action', ruleKey: `mcp:${toolName.split('__').slice(0, 2).join('__')}` };
  }

  return { decision: 'ask', reason: `unknown tool: ${toolName}`, ruleKey: `unknown:${toolName || 'none'}` };
}
