const knownSecrets = new Map();

export function registerSecret(secret) {
  const value = String(secret ?? '').trim();
  if (value) knownSecrets.set(value, (knownSecrets.get(value) || 0) + 1);
  return value;
}

export function forgetSecret(secret) {
  const value = String(secret ?? '').trim();
  const count = knownSecrets.get(value) || 0;
  if (count <= 1) knownSecrets.delete(value);
  else knownSecrets.set(value, count - 1);
}

export function maskSecret(secret) {
  const value = String(secret ?? '').trim();
  if (!value) return '未配置';
  const prefix = value.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}****${value.slice(-4)}`;
}

function redactText(text) {
  let value = String(text ?? '');
  for (const secret of [...knownSecrets.keys()].sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join(maskSecret(secret));
  }
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (secret) => maskSecret(secret))
    .replace(/(Bearer\s+)([A-Za-z0-9_.\-]{8,})/gi, (_, label, secret) => `${label}${maskSecret(secret)}`)
    .replace(/((?:api[_-]?key|secret|token|cookie)\s*[:=]\s*["']?)([^\s"'&,;]{8,})/gi,
      (_, label, secret) => `${label}${maskSecret(secret)}`)
    .replace(/MT[A-Za-z0-9]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, (secret) => maskSecret(secret));
}

export function redactSecrets(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]));
  }
  return value;
}
