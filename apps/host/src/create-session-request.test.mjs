import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostCreateSessionOpts } from './create-session-request.ts';

// A remote controller creating a task with no project sends no id and no
// working directory; the Host must mint the id like the desktop handler does.
test('a dialogue task without an id gets one and a private workspace', () => {
  const allocated = [];
  const opts = readHostCreateSessionOpts({ agentKind: 'claude-code', model: 'm', workspaceKind: 'dialogue' },
    (id) => { allocated.push(id); return `/tmp/dialogue/${id}`; });
  assert.match(opts.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(allocated, [opts.id]);
  assert.equal(opts.workingDir, `/tmp/dialogue/${opts.id}`);
});

test('a supplied id is kept and unsafe ids are still rejected', () => {
  const allocate = (id) => `/tmp/dialogue/${id}`;
  assert.equal(readHostCreateSessionOpts({ agentKind: 'claude-code', model: 'm', workspaceKind: 'dialogue', id: 'given' }, allocate).id, 'given');
  assert.throws(() => readHostCreateSessionOpts({ agentKind: 'claude-code', model: 'm', workspaceKind: 'dialogue', id: '../x' }, allocate));
});
