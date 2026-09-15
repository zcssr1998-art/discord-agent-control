#!/usr/bin/env node
import readline from 'node:readline';
const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'fake-session-1';
console.log(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'fake-model-1',
  apiKeySource: 'www.workbuddy.ai',
  cwd: process.cwd(),
  tools: ['Read', 'Write', 'Bash'],
}));
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
  const error = process.env.WORKBUDDY_FAKE_BACKEND_ERROR || '';
  console.log(JSON.stringify({ type: 'result', result: error || `done:${text}`, is_error: Boolean(error), session_id: sessionId }));
});
