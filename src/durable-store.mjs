// P2.2D: durable operational store backed by SQLite (WAL) at data/jarvis.db.
//
// Scope is intentionally narrow: run/session/follow-up metadata for audit and
// restart-safe reporting. It never stores secrets (credentials stay in
// CredentialStore) and never auto-resumes work after a bridge/OS restart: rows
// still RUNNING at startup are marked INTERRUPTED, pending follow-ups are
// recorded as RESTART_CLEARED when the bridge clears them.
//
// Uses the built-in `node:sqlite` (DatabaseSync) available on the Node 24
// runtime of this host, so no native dependency is added on Windows.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// v2 adds `result_deliveries`: a durable outbox so a completed result is never
// lost just because Discord delivery failed. Execution state (`runs.state`) stays
// independent from delivery state.
export const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  chain_id TEXT,
  channel_id TEXT,
  thread_id TEXT,
  parent_channel_id TEXT,
  workspace TEXT,
  title TEXT,
  prompt TEXT,
  executor_id TEXT,
  provider_id TEXT,
  model TEXT,
  permission_level TEXT,
  session_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  state TEXT,
  duration_ms INTEGER,
  cost_usd REAL,
  tests TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS queued_followups (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  channel_id TEXT,
  position INTEGER,
  state TEXT,
  prompt TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_state ON queued_followups(state);
CREATE TABLE IF NOT EXISTS result_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  channel_id TEXT,
  label TEXT,
  state TEXT,
  attempts INTEGER DEFAULT 0,
  delivered_parts INTEGER DEFAULT 0,
  content TEXT,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_state ON result_deliveries(state);
`;

const STARTABLE_STATES = new Set(['RUNNING', 'QUEUED']);

export class DurableStore {
  constructor({ file, logger = console } = {}) {
    this.file = file;
    this.logger = logger;
    this.db = null;
  }

  /** Idempotent open + migrate. Fig `data/` dir if missing. */
  open() {
    if (this.db) return this;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    // Schema version via user_version; a single-step deterministic migration.
    const [{ user_version: version }] = this.db.prepare('PRAGMA user_version').all();
    if (version > SCHEMA_VERSION) {
      throw new Error(`durable store schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.logger?.log?.(`[store] schema ready at data/jarvis.db (v${SCHEMA_VERSION})`);
    }
    // Runtime interrupted-recovery: anything still active died with the bridge.
    const interrupted = this.db.prepare(
      `UPDATE runs SET state = 'INTERRUPTED', finished_at = COALESCE(finished_at, ?)
       WHERE state IN ('RUNNING','QUEUED') AND started_at < ?`,
    ).run(new Date().toISOString(), new Date().toISOString());
    const [{ changes: n } = { changes: 0 }] = this.db.prepare('SELECT changes() AS changes').all();
    if (n > 0) this.logger?.log?.(`[store] startup recovery: marked ${n} active run(s) interrupted`);
    return this;
  }

  close() {
    if (this.db) { try { this.db.close(); } catch { /* already closed */ } }
    this.db = null;
  }

  #assertOpen() {
    if (!this.db) throw new Error('DurableStore not opened');
  }

  runStart({ runId, chainId = null, channelId, threadId = null, parentChannelId = null, workspace = null,
    title = null, prompt = null, executorId = null, providerId = null, model = null,
    permissionLevel = null, startedAt = null }) {
    this.#assertOpen();
    this.db.prepare(`
      INSERT INTO runs (run_id, chain_id, channel_id, thread_id, parent_channel_id, workspace, title,
        prompt, executor_id, provider_id, model, permission_level, started_at, state)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'RUNNING')
      ON CONFLICT(run_id) DO UPDATE SET
        state='RUNNING', started_at=excluded.started_at, session_id=NULL,
        finished_at=NULL, duration_ms=NULL, cost_usd=NULL, tests=NULL,
        error_code=NULL, error_message=NULL
    `).run(runId, chainId, channelId, threadId, parentChannelId, workspace, title, prompt,
      executorId, providerId, model, permissionLevel, startedAt ?? new Date().toISOString());
  }

  runFinish(runId, { state, durationMs = null, costUsd = null, sessionId = null, tests = null,
    engineModel = null, errorCode = null, errorMessage = null, finishedAt = null } = {}) {
    this.#assertOpen();
    this.db.prepare(`
      UPDATE runs SET state = ?2, finished_at = ?3, duration_ms = ?4, cost_usd = ?5,
        session_id = COALESCE(?6, session_id), tests = ?7,
        model = COALESCE(?8, model), error_code = ?9, error_message = ?10
      WHERE run_id = ?1
    `).run(runId, state, finishedAt ?? new Date().toISOString(), durationMs, costUsd,
      sessionId, tests, engineModel, errorCode,
      errorMessage == null ? null : String(errorMessage).slice(0, 500));
  }

  runSession(runId, sessionId) {
    this.#assertOpen();
    this.db.prepare('UPDATE runs SET session_id = ?2 WHERE run_id = ?1').run(runId, sessionId);
  }

  /** Follow-up / inserted-requirement audit row. State defaults to QUEUED. */
  followUpAdd({ id, runId = null, channelId, position, prompt = null, createdAt = null, state = 'QUEUED' }) {
    this.#assertOpen();
    this.db.prepare(`
      INSERT INTO queued_followups (id, run_id, channel_id, position, state, prompt, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
      ON CONFLICT(id) DO UPDATE SET state=?5, position=excluded.position
    `).run(id, runId, channelId, position, state, prompt, createdAt ?? new Date().toISOString());
  }

  followUpRemove(id, { state = 'EXECUTED' } = {}) {
    this.#assertOpen();
    this.db.prepare('UPDATE queued_followups SET state = ?2 WHERE id = ?1').run(id, state);
  }

  /** Clear a channel's follow-ups (Stop / drain) with a reason for the audit. */
  followUpsClear(channelId, { state = 'CANCELLED' } = {}) {
    this.#assertOpen();
    this.db.prepare('UPDATE queued_followups SET state = ?2 WHERE channel_id = ?1 AND state = ?3')
      .run(channelId, state, 'QUEUED');
  }

  // ---- result delivery outbox (P3.0) ---------------------------------------
  // `runs.state` is the Worker execution state; these rows are the independent
  // Discord delivery state, so a completed result survives a transport outage.

  deliveryCreate({ id, runId = null, channelId, label = 'result', state = 'PENDING', content = '',
    attempts = 0, deliveredParts = 0, createdAt = null }) {
    this.#assertOpen();
    const now = createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO result_deliveries (id, run_id, channel_id, label, state, attempts,
        delivered_parts, content, last_error, created_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?9)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, content=excluded.content,
        channel_id=excluded.channel_id, updated_at=excluded.updated_at
    `).run(id, runId, channelId, label, state, attempts, deliveredParts, content, now);
  }

  deliveryUpdate(id, { state, attempts = null, deliveredParts = null, lastError = null }) {
    this.#assertOpen();
    this.db.prepare(`
      UPDATE result_deliveries SET state = ?2,
        attempts = COALESCE(?3, attempts), delivered_parts = COALESCE(?4, delivered_parts),
        last_error = ?5, updated_at = ?6
      WHERE id = ?1
    `).run(id, state, attempts, deliveredParts,
      lastError == null ? null : String(lastError).slice(0, 500), new Date().toISOString());
  }

  /** PENDING + DEGRADED rows are all recoverable (never a terminal failure). */
  pendingDeliveries(limit = 50) {
    this.#assertOpen();
    return this.db.prepare(`
      SELECT id, run_id, channel_id, label, state, attempts, delivered_parts, content, last_error, created_at
      FROM result_deliveries WHERE state IN ('PENDING','DEGRADED') ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  }

  deliveryCounts() {
    this.#assertOpen();
    const rows = this.db.prepare('SELECT state, COUNT(*) AS count FROM result_deliveries GROUP BY state').all();
    const out = { PENDING: 0, DELIVERED: 0, DEGRADED: 0 };
    for (const row of rows) out[row.state] = row.count;
    return out;
  }

  /** Startup semantics: probe what this store would do WITHOUT changing rows. */
  pendingActiveRuns() {
    this.#assertOpen();
    const state = [...STARTABLE_STATES].map((s) => `'${s}'`).join(',');
    return this.db.prepare(`SELECT run_id, channel_id, state FROM runs WHERE state IN (${state})`).all();
  }

  recentRuns(limit = 5) {
    this.#assertOpen();
    return this.db.prepare('SELECT run_id, state, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  /**
   * The newest run recorded by this workspace, used as evidence for the current
   * effective workspace on the startup card (never a historical default path).
   */
  latestRun() {
    if (!this.db) return null;
    try {
      return this.db.prepare(
        'SELECT run_id, channel_id, workspace, model, provider_id, state, started_at FROM runs ORDER BY started_at DESC LIMIT 1',
      ).get() ?? null;
    } catch { return null; }
  }

  status() {
    if (!this.db) return { open: false, file: this.file };
    const [{ user_version: version }] = this.db.prepare('PRAGMA user_version').all();
    const [{ runCount }] = this.db.prepare('SELECT COUNT(*) AS runCount FROM runs').all();
    const [{ pending }] = this.db.prepare(`SELECT COUNT(*) AS pending FROM queued_followups WHERE state = 'QUEUED'`).all();
    const [{ pendingDeliveries }] = this.db.prepare(
      `SELECT COUNT(*) AS pendingDeliveries FROM result_deliveries WHERE state IN ('PENDING','DEGRADED')`,
    ).all();
    return { open: true, file: this.file, schemaVersion: version, runCount, pendingFollowups: pending, pendingDeliveries };
  }
}

export default DurableStore;
