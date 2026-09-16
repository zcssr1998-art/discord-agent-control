// P2.2A: live build identity read straight from .git without spawning git.
// Deterministic and dependency-free: branch/commit or 'unknown', never invented.

import fs from 'node:fs';
import path from 'node:path';

export function resolveBuildIdentity(root, gitDirEnv = process.env.GIT_DIR || null) {
  const identity = { branch: 'unknown', commit: 'unknown' };
  const gitDir = gitDirEnv ? path.resolve(gitDirEnv) : path.join(root, '.git');
  let headPath = path.join(gitDir, 'HEAD');
  let head = null;
  try { head = fs.readFileSync(headPath, 'utf8').trim(); } catch {
    // .git may be a "worktree pointer": gitdir: <path>
    let pointer = null;
    try { pointer = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'); } catch { pointer = null; }
    return identity;
  }
  if (!head) return identity;
  if (head.startsWith('ref: ')) {
    identity.branch = head.slice(5).replace(/^refs\/heads\//, '');
    const refPath = path.join(gitDir, head.slice(5));
    try { identity.commit = fs.readFileSync(refPath, 'utf8').trim(); } catch {
      // Packed refs
      try {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        for (const line of packed.split(/\r?\n/)) {
          const [sha, ref] = line.split(' ');
          if (sha && ref === head.slice(5)) { identity.commit = sha; break; }
        }
      } catch { /* stay unknown */ }
    }
  } else {
    // Detached HEAD: the content itself is the commit.
    const sha = head.trim();
    if (/[0-9a-f]{40}/i.test(sha)) {
      identity.commit = sha;
      identity.branch = null; // caller renders "detached@sha"
    }
  }
  return identity;
}

/** Short "branch@sha" / "sha" display form; never invents a value. */
export function describeBuild(identity, { shortSha = 7 } = {}) {
  if (!identity || (identity.branch === 'unknown' && identity.commit === 'unknown')) return 'unknown';
  const sha = identity.commit && identity.commit !== 'unknown'
    ? String(identity.commit).slice(0, shortSha) : 'unknown';
  if (identity.branch && identity.branch !== 'unknown') return `${identity.branch}@${sha}`;
  return `detached@${sha}`;
}

export default resolveBuildIdentity;
