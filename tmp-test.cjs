const { execSync } = require('node:child_process');
let out = '';
try { out = execSync('npm test', { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: 'cmd.exe' }); }
catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
const lines = out.split(/\r?\n/);
const idx = lines.findIndex((l) => /failing tests/i.test(l));
console.log(lines.slice(Math.max(0, idx), idx + 90).join('\n'));
