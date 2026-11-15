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

// Production hub + HTTP entry, no real accounts. Regression: an old cursor
// used to silently lose events after a Host restart/window overflow. Unit tier.
test('versioned replay distinguishes complete history, restart, overflow and bad cursors', () => {
  const hub = createEventHub();
  const initial = hub.replay({});
  assert.equal(initial.reason, 'initial');
  for (let n = 0; n < 1002; n++) hub.publish({ type: 'test' });
  const runtime = initial.runtime;
  assert.equal(hub.replay({ runtime, since: '1' }).reason, 'history-lost');
  assert.equal(hub.replay({ runtime, since: '2' }).events.length, 1000);
  assert.equal(hub.replay({ runtime, since: '1001' }).events[0].seq, 1002);
  for (const since of ['-1', '1.5', 'no', '1003', '9007199254740993']) {
    assert.equal(hub.replay({ runtime, since }).reason, 'invalid-cursor');
  }
  const restarted = createEventHub();
  for (let n = 0; n < 1003; n++) restarted.publish({ type: 'test' });
  assert.equal(restarted.replay({ runtime, since: '1002' }).reason, 'restarted');
  hub.clear();
  assert.equal(hub.replay({ runtime, since: '1001' }).reason, 'history-lost');
  assert.deepEqual(hub.replay({ runtime, since: '1002' }).events, []);
});

test('versioned HTTP replay brackets events and keeps legacy subscribers unchanged', async t => {
  const hub = createEventHub();
  hub.publish({ type: 'message_created', sessionId: 's1' });
  const { runtime } = hub.replay({});
  const server = createHostServer({ token: TOKEN, events: hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [query, expected] of [
    ['?protocol=2', ['start', 'ready']],
    [`?protocol=2&since=0&runtime=${runtime}`, ['start', 'message_created', 'ready']],
    ['?protocol=2&since=1&runtime=old-process', ['start', 'ready']],
    ['?since=0', ['message_created']],
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/events${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body.getReader();
    let data = '';
    let frames = [];
    while (frames.length < expected.length) {
      const { value, done } = await reader.read();
      if (done) break;
      data += new TextDecoder().decode(value);
      frames = data.split('\n\n').filter(f => f.startsWith('data:') || f.includes('\ndata:'))
        .map(f => JSON.parse(f.split('\n').find(line => line.startsWith('data:')).slice(5)));
    }
    assert.deepEqual(frames.map(f => f.phase ?? f.type), expected);
    assert.equal(response.headers.get('x-cindy-event-protocol'), query.includes('protocol=2') ? '2' : null);
    await reader.cancel();
  }
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
