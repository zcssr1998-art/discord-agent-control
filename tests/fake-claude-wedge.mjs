#!/usr/bin/env node
/**
 * Reproduces the field failure that took the bot offline.
 *
 * The WorkBuddy CLI accepted the task, emitted `system/init`, ran a few tool
 * calls, and then — after the sandbox blocked the fifth one — produced no
 * `result` event at all. The run log for that task ends on a bare `tool_result`
 * with no `result`, which is exactly what this fixture imitates.
 *
 * DAC_FAKE_WEDGE=exit0  -> init, then exit 0 without ever emitting a result
 * DAC_FAKE_WEDGE=exit1  -> init, then exit 1
 * DAC_FAKE_WEDGE=hang   -> init, then stay alive and silent forever
 * DAC_FAKE_WEDGE=silent -> accept the task and say nothing at all
 */
import readline from 'node:readline';

const mode = process.env.DAC_FAKE_WEDGE || 'exit0';

function emitInit() {
  process.stdout.write(`${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'wedged-session',
    model: 'fast-model',
    apiKeySource: 'www.workbuddy.ai',
    cwd: process.cwd(),
    tools: ['PowerShell'],
  })}\n`);
}

if (mode === 'silent') {
  // Keep the process (and stdin) alive, but never answer.
  process.stdin.resume();
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', () => {
    emitInit();
    if (mode === 'hang') return;
    // Let stdout flush before going away.
    setTimeout(() => process.exit(mode === 'exit1' ? 1 : 0), 30);
  });
}
