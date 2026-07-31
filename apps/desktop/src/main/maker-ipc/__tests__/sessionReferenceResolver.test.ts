import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { serializeSessionReferencePayload } from '../../../shared/agentInputQueue.js';

const remoteInvoke = vi.hoisted(() => vi.fn());
vi.mock('../../device-link/index.js', () => ({
  remoteInvoke,
  getSelfDeviceId: () => 'self-device',
}));

import {
  estimateReferenceTokens,
  MAX_REFERENCE_MESSAGES,
  MAX_REFERENCE_TOKENS,
  resolveSessionReferences,
} from '../sessionReferenceResolver.js';

function historyPage(items: Record<string, unknown>[], hasMore = false) {
  return { ok: true, result: { items, hasMore, nextCursor: null } };
}

describe('sessionReferenceResolver', () => {
  beforeEach(() => remoteInvoke.mockReset());

  it('queries remote user/assistant roles before limiting the recent window', async () => {
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { id: 's-1', title: '远端标题', agentKind: 'cc', clearedAt: '1970-01-01T00:00:00.100Z' },
      })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-3', sessionId: 's-1', role: 'assistant', content: '答复', createdAt: 3 },
        { id: 'm-1', sessionId: 's-1', role: 'user', content: '问题', createdAt: 1 },
      ]));

    await expect(resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }])).resolves.toEqual([{
      sessionId: 's-1',
      title: '远端标题',
      source: 'device-link',
      deviceId: 'dev-1',
      messages: [
        { role: 'user', content: '问题', createdAt: 1 },
        { role: 'assistant', content: '答复', createdAt: 3 },
      ],
      range: 'recent',
      messageCount: 2,
      truncated: false,
    }]);
    expect(remoteInvoke).toHaveBeenNthCalledWith(1, 'dev-1', 'local-db:sessions:get', ['s-1']);
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        sessionId: 's-1',
        roles: ['user', 'assistant'],
        includeRewound: false,
        fromMs: 101,
        limit: MAX_REFERENCE_MESSAGES,
        order: 'desc',
      }),
    ]);
  });

  it('filters hidden synthetic and auto-resume user rows before quoting history', async () => {
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { id: 's-1', title: 'Session' },
      })
      .mockResolvedValueOnce(historyPage([
        { id: 'hidden-raw', sessionId: 's-1', role: 'user', content: '[UI_ACTION_TRIGGER] continue' },
        {
          id: 'hidden-structured',
          sessionId: 's-1',
          role: 'user',
          content: { text: '[UI_ACTION_TRIGGER] continue' },
        },
        {
          id: 'hidden-resume',
          sessionId: 's-1',
          role: 'user',
          content: 'resume internally',
          agentMeta: { autoResume: true },
        },
        { id: 'visible', sessionId: 's-1', role: 'user', content: 'visible user message' },
      ]));

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.messages).toEqual([
      { role: 'user', content: 'visible user message' },
    ]);
  });

  it('fetches another remote page when hidden rows consume the visible window', async () => {
    remoteInvoke
      .mockResolvedValueOnce({
        ok: true,
        result: { id: 's-1', title: 'Session' },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          items: [
            { id: 'hidden', sessionId: 's-1', role: 'user', content: '[UI_ACTION_TRIGGER] continue' },
            { id: 'visible-1', sessionId: 's-1', role: 'user', content: 'visible one' },
          ],
          hasMore: true,
          nextCursor: { createdAt: 2, id: 'hidden' },
        },
      })
      .mockResolvedValueOnce(historyPage([
        { id: 'visible-2', sessionId: 's-1', role: 'assistant', content: 'visible two' },
      ]));

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.messages).toEqual([
      { role: 'assistant', content: 'visible two' },
      { role: 'user', content: 'visible one' },
    ]);
    expect(remoteInvoke).toHaveBeenNthCalledWith(3, 'dev-1', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        cursor: { createdAt: 2, id: 'hidden' },
      }),
    ]);
  });

  it('trims visible rows after remote over-fetching', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1', title: 'Session' } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          items: [
            { id: 'hidden', sessionId: 's-1', role: 'user', content: '[UI_ACTION_TRIGGER] continue' },
            ...Array.from({ length: 19 }, (_, index) => ({
              id: `new-${index}`,
              sessionId: 's-1',
              role: 'user',
              content: `new ${index}`,
            })),
          ],
          hasMore: true,
          nextCursor: { createdAt: 2, id: 'hidden' },
        },
      })
      .mockResolvedValueOnce(historyPage(
        Array.from({ length: 20 }, (_, index) => ({
          id: `old-${index}`,
          sessionId: 's-1',
          role: 'assistant',
          content: `old ${index}`,
        })),
      ));

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.messageCount).toBe(MAX_REFERENCE_MESSAGES);
    expect(context.messages.some((message) => message.content === 'new 0')).toBe(true);
    expect(context.truncated).toBe(true);
  });

  it('uses role-filtered pages around an anchor and reports source truncation', async () => {
    const before = Array.from({ length: 9 }, (_, index) => ({
      id: `before-${index}`,
      sessionId: 's-1',
      role: index % 2 ? 'assistant' : 'user',
      content: `before ${index}`,
      createdAt: index,
    }));
    const after = Array.from({ length: 10 }, (_, index) => ({
      id: `after-${index}`,
      sessionId: 's-1',
      role: index % 2 ? 'assistant' : 'user',
      content: `after ${index}`,
      createdAt: 101 + index,
    }));
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1', title: '远端标题' } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{
          id: 'anchor-id',
          rowid: 42,
          clientId: 'anchor',
          sessionId: 's-1',
          role: 'user',
          content: 'anchor content',
          createdAt: '1970-01-01T00:00:00.100Z',
        }],
      })
      .mockResolvedValueOnce(historyPage([...before].reverse(), true))
      .mockResolvedValueOnce(historyPage(after, false));

    const [context] = await resolveSessionReferences([{
      sessionId: 's-1',
      deviceId: 'dev-1',
      messageClientId: 'anchor',
    }]);
    expect(context).toMatchObject({
      range: 'around-anchor',
      messageClientId: 'anchor',
      messageCount: MAX_REFERENCE_MESSAGES,
      truncated: true,
    });
    expect(context.messages.some((message) => message.content === 'anchor content')).toBe(true);
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, 'dev-1', 'local-db:messages:around-client-id', [
      's-1',
      'anchor',
      { radius: 0, contentCharLimit: 8_000 },
    ]);
    expect(remoteInvoke).toHaveBeenNthCalledWith(3, 'dev-1', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({
        roles: ['user', 'assistant'],
        limit: 9,
        order: 'desc',
        cursor: { createdAt: 100, id: 'anchor-id', rowid: 42 },
      }),
    ]);
    expect(remoteInvoke).toHaveBeenNthCalledWith(4, 'dev-1', DL_HISTORY_MESSAGES_CHANNEL, [
      expect.objectContaining({ roles: ['user', 'assistant'], limit: 10, order: 'asc' }),
    ]);
  });

  it('keeps the anchor when a long following message exhausts the token budget', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{
          id: 'anchor-id',
          clientId: 'anchor',
          sessionId: 's-1',
          role: 'user',
          content: 'must keep this anchor',
          createdAt: 100,
        }],
      })
      .mockResolvedValueOnce(historyPage([]))
      .mockResolvedValueOnce(historyPage([{
        id: 'after-id',
        sessionId: 's-1',
        role: 'assistant',
        content: '中'.repeat(20_000),
        createdAt: 101,
      }]));

    const [context] = await resolveSessionReferences([{
      sessionId: 's-1',
      deviceId: 'dev-1',
      messageClientId: 'anchor',
    }]);
    expect(context.messages.some((message) => message.content === 'must keep this anchor')).toBe(true);
    expect(context.truncated).toBe(true);
  });

  it('marks an anchored neighbor as truncated when it is partially kept', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-anchor' } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{ id: 'anchor-id', clientId: 'anchor', sessionId: 's-anchor', role: 'user', content: 'anchor', createdAt: 100 }],
      })
      .mockResolvedValueOnce(historyPage([]))
      .mockResolvedValueOnce(historyPage([{
        id: 'after-id',
        sessionId: 's-anchor',
        role: 'assistant',
        content: 'x'.repeat(20_000),
        createdAt: 101,
      }]))
      .mockResolvedValueOnce({ ok: true, result: { id: 's-other' } })
      .mockResolvedValueOnce(historyPage([{ id: 'other-id', sessionId: 's-other', role: 'user', content: 'other' }]));

    const contexts = await resolveSessionReferences([
      { sessionId: 's-anchor', deviceId: 'dev-1', messageClientId: 'anchor' },
      { sessionId: 's-other', deviceId: 'dev-1' },
    ]);
    expect(contexts[0]?.truncated).toBe(true);
    const partialNeighbor = contexts[0]?.messages.find((message) => message.role === 'assistant');
    expect(partialNeighbor?.content.length).toBeLessThan(20_000);
  });

  it('probes a zero-sized anchor side so shared message budgets still report truncation', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-anchor' } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{
          id: 'anchor-id',
          clientId: 'anchor',
          sessionId: 's-anchor',
          role: 'user',
          content: 'anchor',
          createdAt: 100,
        }],
      })
      .mockResolvedValueOnce(historyPage([
        { id: 'older', sessionId: 's-anchor', role: 'user', content: 'older', createdAt: 99 },
      ]))
      .mockResolvedValueOnce(historyPage([]));
    for (let index = 0; index < 7; index += 1) {
      remoteInvoke
        .mockResolvedValueOnce({ ok: true, result: { id: `s-${index}` } })
        .mockResolvedValueOnce(historyPage([{
          id: `message-s-${index}`,
          sessionId: `s-${index}`,
          role: 'user',
          content: `s-${index}`,
        }]));
    }

    const contexts = await resolveSessionReferences([
      { sessionId: 's-anchor', deviceId: 'dev-1', messageClientId: 'anchor' },
      ...Array.from({ length: 7 }, (_, index) => ({ sessionId: `s-${index}`, deviceId: 'dev-1' })),
    ]);
    expect(contexts[0]).toMatchObject({ messageCount: 1, truncated: true, range: 'around-anchor' });
  });

  it('uses the remote page hasMore signal for the user-visible truncated flag', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-1', sessionId: 's-1', role: 'assistant', content: 'partial payload' },
      ], true));
    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);
    expect(context.truncated).toBe(true);
  });

  it('fails closed when the source rejects access', async () => {
    remoteInvoke.mockResolvedValueOnce({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'revoked' } });
    await expect(resolveSessionReferences([{ sessionId: 'missing', deviceId: 'dev-1' }])).rejects.toMatchObject({
      code: 'SESSION_REFERENCE_ACCESS_DENIED',
    });
  });

  it.each(['NOT_CONNECTED', 'BACKPRESSURE'] as const)(
    'maps transient remote %s responses to offline instead of not-found',
    async (code) => {
      remoteInvoke.mockResolvedValueOnce({ ok: false, error: { code, message: 'retry later' } });
      await expect(resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }])).rejects.toMatchObject({
        code: 'SESSION_REFERENCE_OFFLINE',
      });
    },
  );

  it('rejects a missing anchor instead of silently injecting an empty quote', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce({ ok: true, result: [{ sessionId: 's-1', clientId: 'other', role: 'user', content: 'x' }] });
    await expect(resolveSessionReferences([{
      sessionId: 's-1',
      deviceId: 'dev-1',
      messageClientId: 'missing',
    }])).rejects.toMatchObject({ code: 'SESSION_REFERENCE_NOT_FOUND' });
  });

  it('truncates one oversized recent message inside the shared token budget', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-1', sessionId: 's-1', role: 'user', content: '中'.repeat(20_000) },
      ]));
    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);
    expect(context.truncated).toBe(true);
    expect(context.messages[0]?.content.startsWith('…')).toBe(true);
    expect(estimateReferenceTokens(context.messages[0]?.content ?? '')).toBeLessThanOrEqual(MAX_REFERENCE_TOKENS);
  });

  it('caps the exact escaped JSON payload, including metadata overhead', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1', title: '题'.repeat(5_000) } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-1', sessionId: 's-1', role: 'user', content: '\u0000\u0001\n'.repeat(10_000) },
      ]));
    const contexts = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);
    expect(estimateReferenceTokens(serializeSessionReferencePayload(contexts)))
      .toBeLessThanOrEqual(MAX_REFERENCE_TOKENS - 128);
    expect(contexts[0]?.title?.length).toBeLessThanOrEqual(128);
    expect(contexts[0]?.truncated).toBe(true);
  });

  it('shares the message and serialized token budgets across multiple references', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-1', sessionId: 's-1', role: 'user', content: '甲'.repeat(10_000) },
      ]))
      .mockResolvedValueOnce({ ok: true, result: { id: 's-2' } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-2', sessionId: 's-2', role: 'assistant', content: '乙'.repeat(10_000) },
      ]));
    const contexts = await resolveSessionReferences([
      { sessionId: 's-1', deviceId: 'dev-1' },
      { sessionId: 's-2', deviceId: 'dev-1' },
    ]);
    expect(contexts).toHaveLength(2);
    expect(contexts.reduce((sum, context) => sum + context.messageCount, 0))
      .toBeLessThanOrEqual(MAX_REFERENCE_MESSAGES);
    expect(estimateReferenceTokens(serializeSessionReferencePayload(contexts)))
      .toBeLessThanOrEqual(MAX_REFERENCE_TOKENS - 128);
  });

  it('rejects more than eight references without invoking a device', async () => {
    await expect(resolveSessionReferences(Array.from({ length: 9 }, (_, index) => ({
      sessionId: `s-${index}`,
      deviceId: 'dev-1',
    })))).rejects.toMatchObject({ code: 'SESSION_REFERENCE_INVALID' });
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('attaches the validated first-page terminal without leaking the error body', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1', title: 'Session' } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          items: [
            { id: 'm-2', sessionId: 's-1', role: 'assistant', content: '我已经看到，但', createdAt: 102 },
            { id: 'm-1', sessionId: 's-1', role: 'user', content: '请继续', createdAt: 101 },
          ],
          hasMore: false,
          nextCursor: null,
          terminal: {
            status: 'error',
            createdAt: 103,
            message: 'provider secret must not cross the quote boundary',
            injected: 'junk',
          },
        },
      });

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.terminal).toEqual({ status: 'error', createdAt: 103 });
    expect(JSON.stringify(context)).not.toContain('provider secret');
    expect(JSON.stringify(context)).not.toContain('junk');
    // 终态与历史页同一次响应到达,没有额外的探测往返。
    expect(remoteInvoke).toHaveBeenCalledTimes(2);
  });

  it('degrades to no terminal when the source page predates the terminal field', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-1', sessionId: 's-1', role: 'assistant', content: 'partial', createdAt: 1 },
      ]));

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.messages).toHaveLength(1);
    expect(context.terminal).toBeUndefined();
  });

  it('ignores malformed terminal payloads from the source device', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1' } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          items: [{ id: 'm-1', sessionId: 's-1', role: 'assistant', content: 'partial', createdAt: 1 }],
          hasMore: false,
          nextCursor: null,
          terminal: { status: 'fatal', body: 'crafted' },
        },
      });

    const [context] = await resolveSessionReferences([{ sessionId: 's-1', deviceId: 'dev-1' }]);

    expect(context.terminal).toBeUndefined();
  });

  it('ignores the page terminal for anchor quotes', async () => {
    remoteInvoke
      .mockResolvedValueOnce({ ok: true, result: { id: 's-1', title: 'Session' } })
      .mockResolvedValueOnce({
        ok: true,
        result: [{ sessionId: 's-1', clientId: 'c-1', id: 'm-2', rowid: 2, role: 'assistant', content: 'anchor', createdAt: 2 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          items: [{ id: 'm-1', sessionId: 's-1', role: 'user', content: 'before', createdAt: 1 }],
          hasMore: false,
          nextCursor: null,
          terminal: { status: 'error', createdAt: 9 },
        },
      })
      .mockResolvedValueOnce(historyPage([
        { id: 'm-3', sessionId: 's-1', role: 'assistant', content: 'after', createdAt: 3 },
      ]));

    const [context] = await resolveSessionReferences([{
      sessionId: 's-1',
      deviceId: 'dev-1',
      messageClientId: 'c-1',
    }]);

    expect(context.range).toBe('around-anchor');
    expect(context.terminal).toBeUndefined();
  });
});
