#!/usr/bin/env node
// Emits its own environment as the "result" so tests can assert which variables
// actually reached a spawned agent process.
import readline from 'node:readline';

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-probe', apiKeySource: 'www.workbuddy.ai', model: 'probe' }));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {
  const interesting = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC') || k.startsWith('OPENAI') || k.startsWith('DAC_') || k === 'DISCORD_BRIDGE_ACTIVE') {
      interesting[k] = v;
    }
  }
  console.log(JSON.stringify({ type: 'result', result: JSON.stringify(interesting), session_id: 'env-probe', is_error: false }));
});
