#!/usr/bin/env node
// Syntax-check every source file so `npm run check` cannot drift out of date
// when a new module is added.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'scripts')),
  ...walk(path.join(root, 'tests')),
].sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr}`);
  }
}

console.log(`checked ${files.length} file(s), ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
