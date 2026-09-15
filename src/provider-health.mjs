const DEFAULT_COOLDOWNS_MS = Object.freeze({
  INVALID_CREDENTIAL: 60 * 60 * 1000,
  QUOTA: 30 * 60 * 1000,
  RATE_LIMIT: 2 * 60 * 1000,
  PROVIDER_ERROR: 60 * 1000,
  TIMEOUT: 30 * 1000,
  UNREACHABLE: 30 * 1000,
  HTTP_ERROR: 20 * 1000,
  UNKNOWN: 15 * 1000,
});

export function classifyProviderFailure(error) {
  if (error?.code) return String(error.code).toUpperCase();
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL';
  if (status === 402) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'PROVIDER_ERROR';
  const text = String(error?.message || error || '').toLowerCase();
  if (/quota|额度|余额|insufficient/.test(text)) return 'QUOTA';
  if (/rate.?limit|too many requests/.test(text)) return 'RATE_LIMIT';
  if (/timeout|timed out/.test(text)) return 'TIMEOUT';
  if (/network|unreachable|econn|fetch failed/.test(text)) return 'UNREACHABLE';
  return 'UNKNOWN';
}

export class ProviderHealthRegistry {
  constructor({ now = () => Date.now(), cooldownsMs = {} } = {}) {
    this.now = now;
    this.cooldownsMs = { ...DEFAULT_COOLDOWNS_MS, ...cooldownsMs };
    this.items = new Map();
  }

  key(providerId, modelId = '*') {
    return `${providerId}::${modelId || '*'}`;
  }

  snapshot(providerId, modelId = '*') {
    const entry = this.items.get(this.key(providerId, modelId));
    if (!entry) return { status: 'unknown', failures: 0, cooldownUntil: 0, lastErrorCode: null };
    return { ...entry };
  }

  canTry(providerId, modelId = '*') {
    const entry = this.items.get(this.key(providerId, modelId));
    return !entry || !entry.cooldownUntil || entry.cooldownUntil <= this.now();
  }

  noteSuccess(providerId, modelId = '*') {
    this.items.set(this.key(providerId, modelId), {
      status: 'healthy',
      failures: 0,
      cooldownUntil: 0,
      lastErrorCode: null,
      lastSuccessAt: this.now(),
    });
  }

  noteFailure(providerId, modelId = '*', error = null) {
    const key = this.key(providerId, modelId);
    const previous = this.items.get(key) || { failures: 0 };
    const code = classifyProviderFailure(error);
    const base = this.cooldownsMs[code] ?? this.cooldownsMs.UNKNOWN;
    const failures = Number(previous.failures || 0) + 1;
    // Keep escalation bounded. Repeated failures stop us hammering a dead backend,
    // while still allowing recovery without a manual restart.
    const factor = Math.min(8, 2 ** Math.max(0, failures - 1));
    const cooldownMs = Math.min(60 * 60 * 1000, base * factor);
    const entry = {
      status: 'cooldown',
      failures,
      cooldownUntil: this.now() + cooldownMs,
      lastErrorCode: code,
      lastFailureAt: this.now(),
    };
    this.items.set(key, entry);
    return { ...entry, cooldownMs };
  }

  reset(providerId = null, modelId = null) {
    if (providerId == null) {
      this.items.clear();
      return;
    }
    if (modelId != null) {
      this.items.delete(this.key(providerId, modelId));
      return;
    }
    for (const key of [...this.items.keys()]) {
      if (key.startsWith(`${providerId}::`)) this.items.delete(key);
    }
  }
}
