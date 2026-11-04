import assert from 'node:assert/strict';
import test from 'node:test';

import { listActiveSessions } from './sessions.mjs';

const row = (id, extra = {}) => ({ id, title: id, agentKind: 'claude-code', model: 'm', workDir: `/w/${id}`, updatedAt: 1, ...extra });

test('hides archived and deleted tasks but keeps active ones', async () => {
  const statuses = new Map([['a', 'active'], ['b', 'archived'], ['c', 'deleted']]);
  const storage = {
    list: async () => [row('a'), row('b'), row('c')],
    getStatus: async (id) => statuses.get(id) ?? null,
  };
  const sessions = await listActiveSessions(storage);
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
  assert.deepEqual(sessions[0], { id: 'a', title: 'a', agentKind: 'claude-code', model: 'm', workDir: '/w/a', updatedAt: 1 });
});

test('a storage without status support keeps every listed task', async () => {
  const sessions = await listActiveSessions({ list: async () => [row('a')] });
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
});
