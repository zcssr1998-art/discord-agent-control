import fs from 'node:fs';
import path from 'node:path';

/**
 * LiteLLM is the primary standard model gateway. Jarvis talks to it as one
 * OpenAI-compatible endpoint (logical aliases such as `chat-fast`) while it
 * keeps ownership of mode, sessions, billing policy and attribution.
 *
 * This module only holds gateway configuration and a small health probe. It
 * deliberately does not duplicate LiteLLM's router/fallback/cost logic.
 */
export const LITELLM_PROVIDER_ID = 'litellm';

const TRUE = /^(1|true|yes|on)$/i;

export function readMasterKey(root = process.cwd()) {
  try {
    return fs.readFileSync(path.join(root, 'data', 'litellm', 'master-key'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the OpenCode Go key for the direct escape hatch. Prefers the explicit
 * environment variable, then the local OpenCode CLI auth store. Never logs it.
 */
export function readOpenCodeGoKey(env = process.env) {
  if (env.OPENCODE_GO_API_KEY) return env.OPENCODE_GO_API_KEY;
  const home = env.USERPROFILE || env.HOME;
  if (!home) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
    return parsed?.['opencode-go']?.key || null;
  } catch {
    return null;
  }
}

export function loadLiteLLMConfig(env = process.env, { root = process.cwd() } = {}) {
  const enabled = env.LITELLM_ENABLED == null || env.LITELLM_ENABLED === ''
    ? true
    : TRUE.test(String(env.LITELLM_ENABLED));
  const rawBase = String(env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1').trim();
  const baseUrl = rawBase.replace(/\/+$/, '');
  const masterKey = env.LITELLM_MASTER_KEY || readMasterKey(root) || null;
  const healthOrigin = baseUrl.replace(/\/v1$/, '');
  return {
    enabled,
    providerId: LITELLM_PROVIDER_ID,
    baseUrl,
    healthUrl: `${healthOrigin}/health/liveliness`,
    masterKey,
    // The curated alias only contains FREE/SUBSCRIPTION routes, so the gateway
    // itself is safe for AUTO. A metered alias must be pinned manually.
    billingType: String(env.LITELLM_BILLING || 'SUBSCRIPTION').toUpperCase(),
    timeoutMs: Number(env.LITELLM_HEALTH_TIMEOUT_MS) || 2500,
  };
}

export async function checkLiteLLMHealth({ healthUrl, masterKey = null, fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  if (!healthUrl) return { ok: false, detail: 'not configured' };
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(masterKey ? { authorization: `Bearer ${masterKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, detail: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
  return { ok: true, detail: 'healthy' };
}
