#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'fake-session-1';
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const input = JSON.parse(line);
  const text = String(input?.message?.content || '');
  // Real Claude Code 2.1.270 emits one of these per thinking token, even with
  // --include-partial-messages off. The runner must not dispatch them.
  console.log(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: sessionId, tokens: 3 }));
  console.log(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: sessionId, tokens: 4 }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `echo:${text}` }] } }));
  console.log(JSON.stringify({ type: 'result', result: `done:${text}`, session_id: sessionId }));
});
