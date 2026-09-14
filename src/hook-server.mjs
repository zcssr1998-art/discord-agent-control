import http from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyToolCall } from './policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretPath = path.resolve(__dirname, '..', 'data', 'hook-secret');

export function ensureHookSecret() {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  if (!fs.existsSync(secretPath)) {
    const secret = cryptoRandom();
    fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  }
  return fs.readFileSync(secretPath, 'utf8').trim();
}

function cryptoRandom() {
  return randomBytes(32).toString('hex');
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function hookBody(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

export function createHookServer({ config, approvalManager, secret, permissionManager = null }) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/pre-tool-use') {
      json(res, 404, { error: 'not found' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      json(res, 401, hookBody('deny', 'invalid bridge secret'));
      return;
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        json(res, 413, hookBody('deny', 'hook payload too large'));
        return;
      }
    }

    let event;
    try { event = JSON.parse(raw || '{}'); }
    catch { json(res, 400, hookBody('deny', 'invalid hook JSON')); return; }

    const toolName = event.tool_name || event.toolName || 'Unknown';
    const toolInput = event.tool_input || event.toolInput || {};
    const cwd = event.cwd || config.defaultCwd;
    const sessionId = event.session_id || event.sessionId || 'unknown';
    const permissionLevel = permissionManager?.getLevelBySession(sessionId) || 'standard';
    const classified = classifyToolCall({ toolName, toolInput, cwd, config, permissionLevel });

    if (classified.decision === 'allow') {
      json(res, 200, hookBody('allow', classified.reason));
      return;
    }

    const answer = await approvalManager.request({
      sessionId,
      ruleKey: classified.ruleKey,
      toolName,
      toolInput,
      cwd,
      reason: classified.reason,
    });
    json(res, 200, hookBody(answer.decision, answer.reason));
  });
}
