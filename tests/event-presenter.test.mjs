import test from 'node:test';
import assert from 'node:assert/strict';
import { EventPresenter } from '../src/event-presenter.mjs';

test('event presenter maps real events locally, redacts inputs, and spends no model tokens', () => {
  const presenter = new EventPresenter({ cwd: 'C:\\repo', model: 'fast-model' });
  presenter.record({ type: 'tool', tool: { name: 'Read', input: { file_path: 'src/policy.mjs' } } });
  presenter.record({ type: 'tool', tool: { name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://example.com' } } });
  presenter.record({ type: 'tool-result', text: '# pass 2\n# fail 0' });
  const rendered = presenter.render();
  assert.match(rendered, /📖 读取/);
  assert.match(rendered, /🌐 访问网络/);
  assert.doesNotMatch(rendered, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(rendered, /💰 成本：\$0/);
  assert.equal(presenter.extraModelTokens, 0);
});
