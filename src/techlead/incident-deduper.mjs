/**
 * P3 TechLead — incident dedupe and cooldown.
 *
 * A stable signature is derived from the smallest sufficient tuple:
 * work/session + incident class + normalized action + normalized error +
 * material progress fingerprint. Duplicate incidents inside the cooldown never
 * wake the model; a real state/progress change yields a new signature.
 */
import { createHash } from 'node:crypto';

export function incidentSignature({ workKey, incidentClass, action = null, errorSignature = null, fingerprintHash = null }) {
  const tuple = [
    String(workKey ?? 'unknown'),
    String(incidentClass ?? 'UNKNOWN'),
    String(action ?? '').toLowerCase().slice(0, 200),
    String(errorSignature ?? '').toLowerCase().slice(0, 200),
    String(fingerprintHash ?? ''),
  ].join('|');
  return createHash('sha1').update(tuple).digest('hex').slice(0, 20);
}

export class IncidentDeduper {
  constructor({ cooldownMs = 5 * 60 * 1000, now = () => Date.now(), maxEntries = 100 } = {}) {
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.now = now;
    this.maxEntries = Math.max(1, Number(maxEntries) || 100);
    this.entries = new Map();
    this.suppressedTotal = 0;
  }

  /** Whether a signature is still cooling down; never triggers a model call. */
  shouldWake(signature, { at = this.now() } = {}) {
    const last = this.entries.get(signature);
    if (last == null) return { wake: true, suppressed: false };
    if (at - last >= this.cooldownMs) return { wake: true, suppressed: false };
    this.suppressedTotal += 1;
    this.entries.set(signature, last);
    return { wake: false, suppressed: true, remainingMs: this.cooldownMs - (at - last) };
  }

  record(signature, { at = this.now() } = {}) {
    this.entries.delete(signature);
    this.entries.set(signature, at);
    this.#trim();
  }

  #trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  snapshot() {
    return [...this.entries.entries()];
  }

  restore(snapshot, { at = this.now() } = {}) {
    if (!Array.isArray(snapshot)) return;
    for (const entry of snapshot) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [signature, lastAt] = entry;
      if (typeof signature !== 'string' || !Number.isFinite(lastAt)) continue;
      // Expired entries carry no dedupe value and would only grow the file.
      if (at - lastAt > this.cooldownMs * 4) continue;
      this.entries.set(signature, lastAt);
    }
    this.#trim();
  }
}
