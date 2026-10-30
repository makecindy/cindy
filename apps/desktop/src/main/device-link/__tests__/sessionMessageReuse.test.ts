import { describe, expect, it } from 'vitest';
import { SessionMessageReuse, isListMessagePush, MAX_LIST_MESSAGE_CHARS } from '@cindy/device-link';
import { encodeMessageBodies, versionMessageBody } from '../sessionMessageReuse';

const text = '列表上已收到的完整回复。'.repeat(2000);
const message = (content = text) => ({
  id: 'm1',
  clientId: 'c1',
  sessionId: 's1',
  role: 'assistant',
  content,
  createdAt: '2026-10-10T00:00:00.000Z',
});
const request = { channel: 'local-db:messages:view', args: ['s1', { lazyDetails: true }] };
const page = (row = message()) => ({
  version: 1,
  items: [{ type: 'messages', key: 'm1', messages: [row] }],
  nextCursor: null,
  hasMore: false,
});

describe('list text reused by the actual history wire projection', () => {
  it('sends long text once, restores it from the request snapshot and keeps new metadata', () => {
    const cache = new SessionMessageReuse();
    cache.receive('host', 'local-db:messages:created', {
      sessionId: 's1',
      message: versionMessageBody(message()),
    });
    const read = cache.prepare('host', request);
    const updated = { ...message(), agentMeta: { model: 'new' } };
    const packed = encodeMessageBodies(request.channel, read.payload.args, page(updated));
    expect(JSON.stringify(packed)).not.toContain(text);
    expect(JSON.stringify(packed).length).toBeLessThan(600);
    // An intervening newer push cannot replace the body associated with this response.
    cache.receive('host', 'local-db:messages:created', {
      sessionId: 's1',
      message: versionMessageBody(message('newer')),
    });
    expect(read.decode(packed)).toEqual(page({ ...updated, ...versionMessageBody(updated) }));
  });

  it('transfers changed bodies, handles nested work groups and supports legacy hosts/controllers', () => {
    const cache = new SessionMessageReuse();
    const initial = cache.prepare('host', request);
    const nested = { ...page(), items: [{ type: 'work', key: 'work', children: page().items }] };
    const first = encodeMessageBodies(request.channel, initial.payload.args, nested);
    expect(initial.decode(first)).toMatchObject(nested);
    const second = cache.prepare('host', request);
    const changed = encodeMessageBodies(
      request.channel,
      second.payload.args,
      page(message('corrected')),
    );
    expect(JSON.stringify(changed)).toContain('corrected');
    expect(second.decode(changed)).toMatchObject(page(message('corrected')));
    expect(second.decode(page())).toEqual(page()); // old Host
    expect(encodeMessageBodies(request.channel, request.args, page())).toEqual(page()); // old controller
  });

  it('isolates computers, tasks and logout; keeps a request usable after eviction', () => {
    const cache = new SessionMessageReuse();
    cache.receive('host', 'local-db:messages:created', {
      sessionId: 's1',
      message: versionMessageBody(message()),
    });
    const read = cache.prepare('host', request);
    const other = cache.prepare('other', request);
    expect(
      JSON.stringify(encodeMessageBodies(request.channel, other.payload.args, page())),
    ).toContain(text);
    cache.clear();
    const packed = encodeMessageBodies(request.channel, read.payload.args, page());
    expect(read.decode(packed)).toMatchObject(page());
    expect(
      JSON.stringify(
        encodeMessageBodies(request.channel, cache.prepare('host', request).payload.args, page()),
      ),
    ).toContain(text);
  });

  it('invalidates deleted bodies and never guesses a missing reference', () => {
    const cache = new SessionMessageReuse();
    cache.receive('host', 'local-db:messages:created', {
      sessionId: 's1',
      message: versionMessageBody(message()),
    });
    cache.receive('host', 'local-db:messages:deleted', { sessionId: 's1', clientId: 'c1' });
    const read = cache.prepare('host', request);
    const { content: _, ...ref } = versionMessageBody(message());
    expect(() => read.decode({ format: 'message-bodies-v1', value: [ref] })).toThrow(
      'Missing remote message body',
    );
    expect(
      JSON.stringify(encodeMessageBodies(request.channel, read.payload.args, page())),
    ).toContain(text);
  });

  it('excludes tool bodies and oversized text from list prefetch', () => {
    expect(isListMessagePush('local-db:messages:created', { message: message() })).toBe(true);
    expect(
      isListMessagePush('local-db:messages:created', {
        message: { ...message(), role: 'tool_result' },
      }),
    ).toBe(false);
    expect(
      isListMessagePush('local-db:messages:created', {
        message: message('a'.repeat(MAX_LIST_MESSAGE_CHARS + 1)),
      }),
    ).toBe(false);
    expect(isListMessagePush('maker:event', { event: { type: 'thinking', data: { text } } })).toBe(
      false,
    );
  });

  it('reuses structured user text but leaves attachments on demand', () => {
    const row = { ...message(), role: 'user', content: { text } };
    const cache = new SessionMessageReuse();
    expect(isListMessagePush('local-db:messages:created', { message: row })).toBe(true);
    expect(
      isListMessagePush('local-db:messages:created', {
        message: { ...row, content: { text, images: [{ url: 'image' }] } },
      }),
    ).toBe(false);
    cache.receive('host', 'local-db:messages:created', {
      sessionId: 's1',
      message: versionMessageBody(row),
    });
    const read = cache.prepare('host', { channel: 'local-db:messages:list', args: ['s1'] });
    const packed = encodeMessageBodies('local-db:messages:list', read.payload.args, [row]);
    expect(JSON.stringify(packed)).not.toContain(text);
    expect(read.decode(packed)).toMatchObject([row]);
  });
});
