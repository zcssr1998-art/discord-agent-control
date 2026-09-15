import test from 'node:test';
import assert from 'node:assert/strict';
import { MODE, parseModeCommand, stripSelfMention } from '../src/mode-router.mjs';

test('mode commands are deterministic and support inline prompts', () => {
  assert.deepEqual(parseModeCommand('work'), { type: 'mode', mode: MODE.WORK, prompt: null });
  assert.deepEqual(parseModeCommand('/CHAT'), { type: 'mode', mode: MODE.CHAT, prompt: null });
  assert.deepEqual(parseModeCommand('!work fix the bug'), { type: 'mode', mode: MODE.WORK, prompt: 'fix the bug' });
  assert.equal(parseModeCommand('what is work stealing?'), null);
});

test('self mention is removed without touching normal content', () => {
  assert.equal(stripSelfMention('<@12345> work', '12345'), 'work');
  assert.equal(stripSelfMention('<@!12345> 你好', '12345'), '你好');
  assert.equal(stripSelfMention('<@999> work', '12345'), '<@999> work');
});
