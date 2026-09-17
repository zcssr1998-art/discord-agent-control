import { planResultDelivery } from './discord/renderers.mjs';
import { redactSecrets } from './secrets.mjs';

/**
 * P3.0 result-delivery state machine.
 *
 * Worker execution state and Discord delivery state are deliberately separate:
 *
 *   execution: RUNNING | SUCCEEDED | FAILED | CANCELLED   (owned by the runner)
 *   delivery:  PENDING | DELIVERED | DEGRADED             (owned here, durable)
 *
 * The full result is persisted BEFORE the first network attempt. A Discord
 * connect/send failure therefore never discards the result and never turns a
 * successful run into a failed one: it schedules a bounded, backed-off retry and
 * keeps the row recoverable (DEGRADED rows are still retried on resume/sweep).
 *
 * Exactly one delivery is performed per planned message: `deliveredParts` is
 * persisted after every chunk so a retry resumes instead of re-sending the whole
 * (already delivered) prefix and spamming the owner.
 */

export const DELIVERY = Object.freeze({
  NOT_READY: 'NOT_READY',
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  DEGRADED: 'DEGRADED',
});

export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 10000, 30000, 60000, 5 * 60 * 1000]);

/** Classify a transport error; network faults are recoverable, not fatal. */
export function classifyDeliveryError(error) {
  const name = String(error?.name ?? '');
  const code = String(error?.code ?? error?.cause?.code ?? '');
  const message = String(error?.message ?? '');
  if (name === 'ConnectTimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'CONNECT_TIMEOUT';
  if (/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network/i.test(message)) return 'NETWORK';
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) return 'TIMEOUT';
  return 'UNKNOWN';
}

export function isRecoverableDeliveryError(error) {
  return classifyDeliveryError(error) !== 'UNKNOWN' || /rate ?limit|429|5\d\d/i.test(String(error?.message ?? ''));
}

export class ResultDelivery {
  constructor({
    store = null,
    logger = console,
    maxAttempts = 6,
    backoffMs = DEFAULT_BACKOFF_MS,
    sweepIntervalMs = 0,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.logger = logger;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 6);
    const backoff = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : DEFAULT_BACKOFF_MS;
    this.backoffMs = backoff.filter((n) => Number.isFinite(n) && n >= 0);
    this.sweepIntervalMs = Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0 ? sweepIntervalMs : 0;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    /** id -> record (in-memory mirror; the store is authoritative for recovery). */
    this.records = new Map();
    this.timers = new Map();
    this.sweepTimer = null;
    this.seq = 0;
  }

  #iso() { return new Date(this.now()).toISOString(); }

  #plan(record) {
    return planResultDelivery(record.content, { fileName: record.fileName });
  }

  #persist(record, { state = record.state, error = record.lastError } = {}) {
    record.state = state;
    record.lastError = error == null ? null : String(error).slice(0, 500);
    record.updatedAt = this.#iso();
    try {
      this.store?.deliveryUpdate(record.id, {
        state, attempts: record.attempts, deliveredParts: record.deliveredParts, lastError: record.lastError,
      });
    } catch { /* audit-only: never let an outbox write break delivery */ }
  }

  /** Persist the full result + create the recoverable outbox row. */
  prepare({ id = null, runId = null, channelId, label = 'result', content, fileName = null }) {
    const deliveryId = id ?? `dlv-${channelId}-${this.now()}-${++this.seq}`;
    const record = {
      id: deliveryId,
      runId,
      channelId,
      label,
      content: String(content ?? ''),
      fileName: fileName ?? `jarvis-${label}-${deliveryId}.md`,
      state: DELIVERY.PENDING,
      attempts: 0,
      deliveredParts: 0,
      lastError: null,
      createdAt: this.#iso(),
      updatedAt: this.#iso(),
      resolveSend: null,
    };
    this.records.set(record.id, record);
    try {
      this.store?.deliveryCreate({
        id: record.id, runId, channelId, label, state: DELIVERY.PENDING,
        content: record.content, createdAt: record.createdAt,
      });
    } catch (error) {
      this.logger?.warn?.(`[delivery] could not persist outbox row: ${redactSecrets(error?.message || error)}`);
    }
    return record;
  }

  #clearTimer(id) {
    const timer = this.timers.get(id);
    if (timer != null) { try { this.clearTimer(timer); } catch { /* ignore */ } this.timers.delete(id); }
  }

  #schedule(record) {
    if (this.timers.has(record.id)) return;
    const index = Math.min(Math.max(0, record.attempts - 1), this.backoffMs.length - 1);
    const delay = this.backoffMs[index];
    const timer = this.setTimer(() => {
      this.timers.delete(record.id);
      // Return the promise so an injectable test timer can await the retry; a
      // real setTimeout simply ignores the return value.
      return this.retry(record).catch(() => {});
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    this.timers.set(record.id, timer);
  }

  async #sendPlan(record, send) {
    const plan = this.#plan(record);
    if (plan.mode === 'attachment') {
      if (record.deliveredParts >= 1) return;
      const preview = [
        `🧾 结果较长（${plan.totalChars} 字符），完整内容见附件 \`${plan.attachment.name}\`。`,
        '',
        plan.preview,
      ].join('\n');
      await send({ content: preview, file: { name: plan.attachment.name, content: plan.attachment.content } });
      record.deliveredParts = 1;
      this.#persist(record);
      return;
    }
    const chunks = plan.chunks;
    for (let i = record.deliveredParts; i < chunks.length; i += 1) {
      await send({ content: chunks[i] });
      record.deliveredParts = i + 1;
      this.#persist(record);
    }
  }

  /**
   * First (in-turn) delivery attempt. `send` is the caller-provided immediate
   * transport; `resolveSend` lets a later retry rebuild a transport (e.g. from a
   * channel id) after the original message context is gone.
   */
  async deliver(record, { send, resolveSend = null } = {}) {
    record.resolveSend = resolveSend;
    record.attempts += 1;
    try {
      await this.#sendPlan(record, send);
      this.#persist(record, { state: DELIVERY.DELIVERED, error: null });
      this.#clearTimer(record.id);
      return { ok: true, state: DELIVERY.DELIVERED, mode: this.#plan(record).mode, record };
    } catch (error) {
      const recoverable = isRecoverableDeliveryError(error);
      const exhausted = !recoverable || record.attempts >= this.maxAttempts;
      this.#persist(record, { state: exhausted ? DELIVERY.DEGRADED : DELIVERY.PENDING });
      if (!exhausted) this.#schedule(record);
      return { ok: false, state: record.state, error, recoverable, record };
    }
  }

  /**
   * Retry one outbox row. `manual` resets the attempt budget so the owner can
   * always force a redelivery; otherwise the bounded backoff ladder applies.
   */
  async retry(record, { manual = false } = {}) {
    if (record.state === DELIVERY.DELIVERED) return { ok: true, state: record.state, record };
    if (manual) { record.attempts = 0; this.#clearTimer(record.id); }
    record.attempts += 1;
    const skip = () => { this.#persist(record); this.#schedule(record); };
    let send = null;
    try { send = record.resolveSend ? await record.resolveSend(record) : null; }
    catch (error) {
      record.lastError = redactSecrets(error?.message || error);
      if (record.attempts >= this.maxAttempts) this.#persist(record, { state: DELIVERY.DEGRADED });
      else skip();
      return { ok: false, state: record.state, error, record };
    }
    if (!send) {
      // No transport available yet: keep it recoverable, never drop the result.
      if (record.attempts >= this.maxAttempts) this.#persist(record, { state: DELIVERY.DEGRADED });
      else skip();
      return { ok: false, state: record.state, record };
    }
    try {
      await this.#sendPlan(record, send);
      this.#persist(record, { state: DELIVERY.DELIVERED, error: null });
      this.logger?.log?.(`[delivery] ${record.id} delivered on attempt ${record.attempts}`);
      return { ok: true, state: DELIVERY.DELIVERED, record };
    } catch (error) {
      const recoverable = isRecoverableDeliveryError(error);
      const exhausted = !recoverable || record.attempts >= this.maxAttempts;
      this.#persist(record, { state: exhausted ? DELIVERY.DEGRADED : DELIVERY.PENDING });
      if (!exhausted) this.#schedule(record);
      else this.logger?.warn?.(`[delivery] ${record.id} degraded after ${record.attempts} attempt(s): ${redactSecrets(error?.message || error)}`);
      return { ok: false, state: record.state, error, recoverable, record };
    }
  }

  /** Recover PENDING/DEGRADED rows (startup, or after a channel becomes usable). */
  async resumePending({ resolveSend }) {
    let rows = [];
    try { rows = this.store?.pendingDeliveries?.() ?? []; } catch { rows = []; }
    const resumed = [];
    for (const row of rows) {
      if (this.records.has(row.id)) continue;
      const record = {
        id: row.id,
        runId: row.run_id,
        channelId: row.channel_id,
        label: row.label,
        content: row.content ?? '',
        fileName: `jarvis-${row.label || 'result'}-${row.id}.md`,
        state: row.state === DELIVERY.DEGRADED ? DELIVERY.DEGRADED : DELIVERY.PENDING,
        attempts: row.attempts ?? 0,
        deliveredParts: row.delivered_parts ?? 0,
        lastError: row.last_error ?? null,
        createdAt: row.created_at,
        updatedAt: this.#iso(),
        resolveSend,
      };
      this.records.set(record.id, record);
      this.#schedule(record);
      resumed.push(record);
    }
    if (resumed.length) this.logger?.log?.(`[delivery] resumed ${resumed.length} pending delivery(ies)`);
    this.#ensureSweep();
    return resumed;
  }

  #ensureSweep() {
    if (this.sweepTimer || !this.sweepIntervalMs) return;
    this.sweepTimer = this.setTimer(() => {
      this.sweepTimer = null;
      this.sweep().catch(() => {});
    }, this.sweepIntervalMs);
    if (typeof this.sweepTimer?.unref === 'function') this.sweepTimer.unref();
  }

  /** Low-frequency recovery for rows that exhausted the fast backoff ladder. */
  async sweep() {
    for (const record of this.records.values()) {
      if (record.state === DELIVERY.DELIVERED) continue;
      if (this.timers.has(record.id)) continue;
      await this.retry(record).catch(() => {});
    }
    this.#ensureSweep();
    return this.status();
  }

  pending() {
    return [...this.records.values()].filter((record) => record.state !== DELIVERY.DELIVERED);
  }

  status() {
    const values = [...this.records.values()];
    const by = (state) => values.filter((record) => record.state === state).length;
    return {
      pending: by(DELIVERY.PENDING),
      degraded: by(DELIVERY.DEGRADED),
      delivered: by(DELIVERY.DELIVERED),
      last: values.at(-1) ?? null,
    };
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.#clearTimer(id);
    if (this.sweepTimer) { try { this.clearTimer(this.sweepTimer); } catch { /* ignore */ } this.sweepTimer = null; }
  }
}

export default ResultDelivery;
