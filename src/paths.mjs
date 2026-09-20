import path from 'node:path';

/**
 * P0 uptime test isolation: every git-ignored runtime file lives under one
 * data directory. Production defaults to `<root>/data`; a test/harness sets
 * JARVIS_DATA_DIR to a temp dir so booting the real entry point never reads
 * or writes the owner's state/credentials/providers/history/db.
 */
export function resolveDataDir(rootDir, env = process.env) {
  const override = String(env?.JARVIS_DATA_DIR ?? '').trim();
  return override ? path.resolve(override) : path.join(rootDir, 'data');
}

export default { resolveDataDir };
