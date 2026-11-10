import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventHub } from './events.mjs';
import { createHostServer } from './server.mjs';

const TOKEN = 'test-token-value';

test('createEventHub assigns monotonic sequence IDs and supports getEventsSince', () => {
  const hub = createEventHub();
  assert.equal(hub.currentSeq(), 0);

  const e1 = hub.publish({ type: 'session_changed', sessionId: 's1', status: 'active' });
  const e2 = hub.publish({ type: 'message_created', sessionId: 's1', messageId: 'm1' });
  const e3 = hub.publish({ type: 'settings_changed', domain: 'appearance', value: { theme: 'dark' } });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(hub.currentSeq(), 3);

  const since1 = hub.getEventsSince(1);
  assert.equal(since1.length, 2);
  assert.equal(since1[0].seq, 2);
  assert.equal(since1[1].seq, 3);

  const sinceAll = hub.getEventsSince(0);
  assert.equal(sinceAll.length, 3);

  const sinceFuture = hub.getEventsSince(10);
  assert.equal(sinceFuture.length, 0);
});

test('/events SSE endpoint streams events with seq and replays on reconnect', async (t) => {
  const hub = createEventHub();
  const server = createHostServer({
    token: TOKEN,
    events: hub,
    probe: () => ({ status: 'ok' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  // 1. Publish two events before client connects
  hub.publish({ type: 'session_changed', sessionId: 's1', patch: { title: 'First Task' }, status: 'active' });
  hub.publish({ type: 'message_created', sessionId: 's1', messageId: 'm1' });

  // 2. Connect to /events with since=1 (simulating reconnect from seq 1)
  const response = await fetch(`http://127.0.0.1:${port}/events?since=1`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read the replayed second event
  while (!buffer.includes('message_created')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  assert.match(buffer, /id: 2/);
  assert.match(buffer, /message_created/);

  // 3. Publish a third live event while connected
  hub.publish({ type: 'settings_changed', domain: 'layout', value: { sidebar: true } });

  while (!buffer.includes('settings_changed')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  assert.match(buffer, /id: 3/);
  assert.match(buffer, /settings_changed/);

  await reader.cancel();
});
