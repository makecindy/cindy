import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DeviceLinkError,
  DL_HISTORY_MESSAGES_CHANNEL,
  DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
} from '@cindy/device-link';
import { i18n } from '@/i18n';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import {
  estimateMobileReferenceTokens,
  extractMobileSessionReferences,
  formatMobileSessionReferenceMetadata,
  MAX_MOBILE_REFERENCE_MESSAGES,
  MobileSessionReferenceError,
  canFallbackToStoredMobileSessionReferenceSnapshot,
  prepareMobileQueuedSessionReferencesForSteer,
  prepareMobileQueuedSessionReferences,
  resolveMobileSessionReferences,
  serializeMobileSessionReferencePayload,
  type MobileSessionReference,
  type MobileSessionReferenceContext,
} from '@/session/sessionReferences';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function message(
  sessionId: string,
  id: string,
  clientId: string,
  content: string,
  role: 'user' | 'assistant' | 'tool_use' = 'user',
  createdAt = 1_000,
): Record<string, unknown> {
  return { sessionId, id, clientId, content, role, createdAt };
}

function asInvoke(
  implementation: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>,
): RemoteInvoke {
  return (deviceId, channel, args = []) => implementation(deviceId, channel, args) as Promise<never>;
}

describe('mobile session-reference links', () => {
  it('only permits stored-snapshot fallback for transient source outages', () => {
    expect(canFallbackToStoredMobileSessionReferenceSnapshot(
      new MobileSessionReferenceError('SESSION_REFERENCE_OFFLINE', 'offline'),
    )).toBe(true);
    expect(canFallbackToStoredMobileSessionReferenceSnapshot(
      new MobileSessionReferenceError('SESSION_REFERENCE_ACCESS_DENIED', 'revoked'),
    )).toBe(true);
    expect(canFallbackToStoredMobileSessionReferenceSnapshot(
      new MobileSessionReferenceError('SESSION_REFERENCE_NOT_FOUND', 'missing'),
    )).toBe(false);
  });

  it('retains a queued steer projection when the source is unavailable', async () => {
    const item = {
      text: 'continue cindy://session/source',
      sessionRefs: [{ sessionId: 'source', deviceId: 'dev-source' }],
    };
    const invoke = asInvoke(async (_deviceId, channel) => {
      if (channel === DL_SESSION_REFERENCE_CAPABILITY_CHANNEL) {
        return { supported: true, version: 1 };
      }
      throw new DeviceLinkError('DEVICE_OFFLINE', 'source offline');
    });

    await expect(prepareMobileQueuedSessionReferencesForSteer(
      item,
      invoke,
      () => 'dev-source',
      'dev-target',
    )).resolves.toBe(item);
  });

  it('extracts both schemes, anchors, source devices, and removes exact duplicates', () => {
    const deviceBySession: Record<string, string> = { 'session-a': 'dev-a', 'session b': 'dev-b' };
    const refs = extractMobileSessionReferences(
      [
        'cindy://session/session-a',
        'xdt-maker://session/session%20b?foo=1&message=client%2F2',
        'cindy://session/session-a',
        'cindy://session/session-a?message=anchor',
      ].join(' '),
      (sessionId) => deviceBySession[sessionId],
    );

    expect(refs).toEqual([
      { sessionId: 'session-a', deviceId: 'dev-a' },
      { sessionId: 'session b', messageClientId: 'client/2', deviceId: 'dev-b' },
      { sessionId: 'session-a', messageClientId: 'anchor', deviceId: 'dev-a' },
    ]);
  });

  it('ignores malformed encodings without losing valid links', () => {
    expect(extractMobileSessionReferences(
      'cindy://session/%ZZ xdt-maker://session/ok?message=%ZZ',
      () => 'dev-a',
    )).toEqual([{ sessionId: 'ok', deviceId: 'dev-a' }]);
  });

  it('preserves a source device hint when only the link anchor changes', () => {
    expect(extractMobileSessionReferences(
      'cindy://session/source',
      () => undefined,
      [{ sessionId: 'source', messageClientId: 'anchor', deviceId: 'source-device' }],
    )).toEqual([{ sessionId: 'source', deviceId: 'source-device' }]);
  });

  it('clears stale refs and trusted snapshots when an edit removes the link', async () => {
    const invoke = vi.fn();
    const prepared = await prepareMobileQueuedSessionReferences({
      text: 'plain text after editing',
      sessionRefs: [{ sessionId: 'old', deviceId: 'dev-old' }],
      trustedSessionReferenceContexts: [{
        sessionId: 'old',
        source: 'device-link',
        deviceId: 'dev-old',
        messages: [{ role: 'user', content: 'old secret' }],
        range: 'recent',
        messageCount: 1,
        truncated: false,
      }],
      sessionReferencesRequireTrustedSnapshot: true,
    }, asInvoke(invoke), () => undefined, 'target-device');

    expect(prepared).toEqual({ text: 'plain text after editing' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('formats the persisted range summary without referenced message bodies', () => {
    expect(formatMobileSessionReferenceMetadata({
      sessionId: 'source',
      messageClientId: 'anchor',
      range: 'around-anchor',
      messageCount: 4,
      truncated: true,
    })).toBe('链接附近 · 4 条 · 已截断');
  });

  it('rejects an old target before reading history from the source device', async () => {
    const invoke = vi.fn(async (deviceId: string, channel: string) => {
      expect(deviceId).toBe('target-old');
      expect(channel).toBe(DL_SESSION_REFERENCE_CAPABILITY_CHANNEL);
      throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old target');
    });

    await expect(prepareMobileQueuedSessionReferences(
      { text: 'compare cindy://session/source' },
      asInvoke(invoke),
      () => 'source-device',
      'target-old',
    )).rejects.toMatchObject({ code: 'SESSION_REFERENCE_UNSUPPORTED' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('probes a new target before resolving source history', async () => {
    const channels: string[] = [];
    const invoke = asInvoke(async (_deviceId, channel, args) => {
      channels.push(channel);
      if (channel === DL_SESSION_REFERENCE_CAPABILITY_CHANNEL) {
        return { supported: true, version: 1 };
      }
      if (channel === 'local-db:sessions:get') return { id: args[0], title: 'Source' };
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        return {
          items: [message('source', '1', 'c1', 'trusted body')],
          hasMore: false,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    const prepared = await prepareMobileQueuedSessionReferences<{
      text: string;
      trustedSessionReferenceContexts?: MobileSessionReferenceContext[];
    }>(
      { text: 'compare cindy://session/source' },
      invoke,
      () => 'source-device',
      'target-new',
    );

    expect(channels).toEqual([
      DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
      'local-db:sessions:get',
      DL_HISTORY_MESSAGES_CHANNEL,
    ]);
    expect(prepared.trustedSessionReferenceContexts?.[0]?.messages[0]?.content)
      .toBe('trusted body');
  });

  it('preserves queued source device hints when the live mirror is unavailable', async () => {
    const invoke = asInvoke(async (_deviceId, channel, args) => {
      if (channel === DL_SESSION_REFERENCE_CAPABILITY_CHANNEL) {
        return { supported: true, version: 1 };
      }
      if (channel === 'local-db:sessions:get') return { id: args[0], title: 'Source' };
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        return {
          items: [message('source', '1', 'c1', 'trusted body')],
          hasMore: false,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    const prepared = await prepareMobileQueuedSessionReferences<{
      text: string;
      sessionRefs: MobileSessionReference[];
      trustedSessionReferenceContexts?: MobileSessionReferenceContext[];
    }>(
      {
        text: 'compare cindy://session/source',
        sessionRefs: [{ sessionId: 'source', deviceId: 'source-device' }],
      },
      invoke,
      () => undefined,
      'target-device',
    );

    expect(prepared.sessionRefs).toEqual([
      { sessionId: 'source', deviceId: 'source-device' },
    ]);
    expect(prepared.trustedSessionReferenceContexts?.[0]?.deviceId)
      .toBe('source-device');
  });

  it('accepts newer compatible capability versions', async () => {
    const invoke = asInvoke(async (_deviceId, channel, args) => {
      if (channel === DL_SESSION_REFERENCE_CAPABILITY_CHANNEL) {
        return { supported: true, version: 2 };
      }
      if (channel === 'local-db:sessions:get') return { id: args[0], title: 'Source' };
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        return {
          items: [message('source', '1', 'c1', 'trusted body')],
          hasMore: false,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    const prepared = await prepareMobileQueuedSessionReferences<{
      text: string;
      trustedSessionReferenceContexts?: MobileSessionReferenceContext[];
    }>(
      { text: 'compare cindy://session/source' },
      invoke,
      () => 'source-device',
      'target-new',
    );

    expect(prepared.trustedSessionReferenceContexts?.[0]?.messages[0]?.content)
      .toBe('trusted body');
  });
});

describe('resolveMobileSessionReferences', () => {
  it('reads recent history from the source device with the hardened history query', async () => {
    const invokeMock = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
      expect(deviceId).toBe('dev-c');
      if (channel === 'local-db:sessions:get') {
        return {
          id: 'session-c',
          title: ' Source session ',
          clearedAt: '2026-07-22T00:00:00.000Z',
        };
      }
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        return {
          items: [
            message('session-c', '3', 'c3', 'newest', 'assistant', 3_000),
            message('session-c', '2', 'c2', 'hidden tool', 'tool_use', 2_000),
            message('session-c', '1', 'c1', 'oldest', 'user', 1_000),
            message('wrong-session', '0', 'c0', 'wrong', 'user', 0),
          ],
          hasMore: true,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });
    const invoke = asInvoke(invokeMock);

    const [context] = await resolveMobileSessionReferences([
      { sessionId: 'session-c', deviceId: 'dev-c' },
    ], invoke);

    expect(context).toMatchObject({
      sessionId: 'session-c',
      deviceId: 'dev-c',
      title: 'Source session',
      source: 'device-link',
      range: 'recent',
      messageCount: 2,
      truncated: true,
    });
    expect(context.messages.map((item) => item.content)).toEqual(['oldest', 'newest']);
    const historyCall = invokeMock.mock.calls.find((call) => call[1] === DL_HISTORY_MESSAGES_CHANNEL);
    expect(historyCall?.[2]).toEqual([expect.objectContaining({
      sessionId: 'session-c',
      fromMs: Date.parse('2026-07-22T00:00:00.000Z') + 1,
      roles: ['user', 'assistant'],
      includeRewound: false,
      contentCharLimit: 8_000,
      order: 'desc',
      limit: 20,
    })]);
  });

  it('filters hidden synthetic and auto-resume user rows before quoting history', async () => {
    const invoke = asInvoke(async (_deviceId, channel) => {
      if (channel === 'local-db:sessions:get') return { id: 's1', title: 'Session' };
      return {
        items: [
          message('s1', '1', 'hidden-raw', '[UI_ACTION_TRIGGER] continue', 'user'),
          {
            ...message('s1', '2', 'hidden-structured', 'ignored', 'user'),
            content: { text: '[UI_ACTION_TRIGGER] continue' },
          },
          {
            ...message('s1', '3', 'hidden-resume', 'resume internally', 'user'),
            agentMeta: { autoResume: true },
          },
          message('s1', '4', 'visible', 'visible user message', 'user'),
        ],
        hasMore: false,
      };
    });

    const [context] = await resolveMobileSessionReferences([
      { sessionId: 's1', deviceId: 'dev-a' },
    ], invoke);

    expect(context.messages).toEqual([
      { role: 'user', content: 'visible user message', createdAt: 1_000 },
    ]);
  });

  it('fetches another remote page when hidden rows consume the visible window', async () => {
    const invokeMock = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
      if (channel === 'local-db:sessions:get') return { id: 's1', title: 'Session' };
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        const request = args[0] as { cursor: unknown };
        if (request.cursor === null) {
          return {
            items: [
              message('s1', 'hidden', 'hidden', '[UI_ACTION_TRIGGER] continue'),
              message('s1', 'visible-1', 'visible-1', 'visible one'),
            ],
            hasMore: true,
            nextCursor: { createdAt: 2, id: 'hidden' },
          };
        }
        return {
          items: [message('s1', 'visible-2', 'visible-2', 'visible two', 'assistant')],
          hasMore: false,
          nextCursor: null,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    const [context] = await resolveMobileSessionReferences(
      [{ sessionId: 's1', deviceId: 'dev-a' }],
      asInvoke(invokeMock),
    );

    expect(context.messages.map((item) => item.content)).toEqual(['visible two', 'visible one']);
    expect(invokeMock.mock.calls.filter((call) => call[1] === DL_HISTORY_MESSAGES_CHANNEL)).toHaveLength(2);
  });

  it('loads an anchor and chronological messages on both sides', async () => {
    const invokeMock = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
      if (channel === 'local-db:sessions:get') return { id: 's1', title: 'Anchored' };
      if (channel === 'local-db:messages:around-client-id') {
        expect(args).toEqual(['s1', 'anchor', { radius: 0, contentCharLimit: 8_000 }]);
        return [{ ...message('s1', '5', 'anchor', 'anchor body', 'assistant', 5_000), rowid: 42 }];
      }
      if (channel === DL_HISTORY_MESSAGES_CHANNEL) {
        const request = args[0] as { order: string; cursor: unknown };
        expect(request.cursor).toEqual({ createdAt: 5_000, id: '5', rowid: 42 });
        if (request.order === 'desc') {
          return {
            items: [
              message('s1', '4', 'c4', 'before 4', 'user', 4_000),
              message('s1', '3', 'c3', 'before 3', 'assistant', 3_000),
            ],
            hasMore: false,
          };
        }
        return {
          items: [
            message('s1', '6', 'c6', 'after 6', 'user', 6_000),
            message('s1', '7', 'c7', 'after 7', 'assistant', 7_000),
          ],
          hasMore: false,
        };
      }
      throw new Error(`unexpected channel ${channel}`);
    });

    const [context] = await resolveMobileSessionReferences([
      { sessionId: 's1', messageClientId: 'anchor', deviceId: 'dev-b' },
    ], asInvoke(invokeMock));

    expect(context.range).toBe('around-anchor');
    expect(context.messageClientId).toBe('anchor');
    expect(context.messages.map((item) => item.content)).toEqual([
      'before 3',
      'before 4',
      'anchor body',
      'after 6',
      'after 7',
    ]);
  });

  it('marks an anchored neighbor as truncated when it is partially kept', async () => {
    const invoke = asInvoke(async (_deviceId, channel, args) => {
      if (channel === 'local-db:sessions:get') return { id: args[0] };
      if (channel === 'local-db:messages:around-client-id') {
        return [message('s-anchor', '1', 'anchor', 'anchor', 'user', 1_000)];
      }
      const request = args[0] as { sessionId: string; order: string };
      if (request.sessionId === 's-other') {
        return { items: [message('s-other', '3', 'other', 'other')], hasMore: false };
      }
      if (request.order === 'desc') return { items: [], hasMore: false };
      return { items: [message('s-anchor', '2', 'after', 'x'.repeat(20_000), 'assistant', 2_000)], hasMore: false };
    });
    const [context] = await resolveMobileSessionReferences([
      { sessionId: 's-anchor', messageClientId: 'anchor', deviceId: 'dev-a' },
      { sessionId: 's-other', deviceId: 'dev-a' },
    ], invoke);
    expect(context.truncated).toBe(true);
    const partialNeighbor = context.messages.find((item) => item.role === 'assistant');
    expect(partialNeighbor?.content.length).toBeLessThan(20_000);
  });

  it('routes each reference to its own authorized source and shares the 20-message limit', async () => {
    const calls: Array<{ deviceId: string; sessionId: string; limit: number }> = [];
    const invoke = asInvoke(async (deviceId, channel, args) => {
      if (channel === 'local-db:sessions:get') return { id: args[0], title: deviceId };
      const request = args[0] as { sessionId: string; limit: number };
      calls.push({ deviceId, sessionId: request.sessionId, limit: request.limit });
      return {
        items: Array.from({ length: request.limit }, (_, index) =>
          message(request.sessionId, `${index}`, `c${index}`, `${deviceId}-${index}`, 'user', index)),
        hasMore: true,
      };
    });
    const refs: MobileSessionReference[] = [
      { sessionId: 'on-b', deviceId: 'dev-b' },
      { sessionId: 'on-c', deviceId: 'dev-c' },
    ];

    const contexts = await resolveMobileSessionReferences(refs, invoke);

    expect(calls).toEqual([
      { deviceId: 'dev-b', sessionId: 'on-b', limit: 10 },
      { deviceId: 'dev-c', sessionId: 'on-c', limit: 10 },
    ]);
    expect(contexts.reduce((total, context) => total + context.messageCount, 0))
      .toBe(MAX_MOBILE_REFERENCE_MESSAGES);
    expect(contexts.map((context) => context.deviceId)).toEqual(['dev-b', 'dev-c']);
  });

  it('always retains an oversized anchor and fits the exact serialized payload budget', async () => {
    const anchorBody = '\u4e2d'.repeat(20_000);
    const invoke = asInvoke(async (_deviceId, channel) => {
      if (channel === 'local-db:sessions:get') return { id: 's1', title: 'T'.repeat(128) };
      if (channel === 'local-db:messages:around-client-id') {
        return [message('s1', '1', 'anchor', anchorBody, 'user', 1_000)];
      }
      return { items: [], hasMore: false };
    });

    const [context] = await resolveMobileSessionReferences([
      { sessionId: 's1', messageClientId: 'anchor', deviceId: 'dev-a' },
    ], invoke);

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.content.endsWith('\u4e2d'.repeat(100))).toBe(true);
    expect(context.truncated).toBe(true);
    expect(estimateMobileReferenceTokens(serializeMobileSessionReferencePayload([context])))
      .toBeLessThanOrEqual(8_000 - 128);
  });

  it.each([
    ['ACCESS_REVOKED', 'SESSION_REFERENCE_ACCESS_DENIED'],
    ['LINK_NOT_OPEN', 'SESSION_REFERENCE_OFFLINE'],
    ['CHANNEL_NOT_ALLOWED', 'SESSION_REFERENCE_UNSUPPORTED'],
  ] as const)('maps %s source failures to %s', async (deviceCode, referenceCode) => {
    const invoke = asInvoke(async () => {
      throw new DeviceLinkError(deviceCode, 'source failure');
    });

    await expect(resolveMobileSessionReferences([
      { sessionId: 's1', deviceId: 'dev-a' },
    ], invoke)).rejects.toMatchObject({ code: referenceCode });
  });

  it('fails closed when the store cannot identify a source device', async () => {
    const invoke = asInvoke(async () => ({ id: 'should-not-run' }));
    const error = await resolveMobileSessionReferences([{ sessionId: 'unknown' }], invoke)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MobileSessionReferenceError);
    expect(error).toMatchObject({ code: 'SESSION_REFERENCE_NOT_FOUND' });
  });

  it('allows mirrored SSH history and still rejects more than eight references before reading history', async () => {
    const sshContext = await resolveMobileSessionReferences([
      { sessionId: 'ssh', deviceId: 'dev-a' },
    ], asInvoke(async (_deviceId, channel) => {
      if (channel === 'local-db:sessions:get') return { id: 'ssh', remoteHostId: 'host-1' };
      return { items: [{ sessionId: 'ssh', role: 'user', content: 'ssh history' }], hasMore: false };
    }));
    expect(sshContext[0]?.messages).toEqual([{ role: 'user', content: 'ssh history' }]);

    const neverInvoke = vi.fn();
    await expect(resolveMobileSessionReferences(
      Array.from({ length: 9 }, (_, index) => ({ sessionId: `s${index}`, deviceId: 'dev-a' })),
      asInvoke(neverInvoke),
    )).rejects.toMatchObject({ code: 'SESSION_REFERENCE_INVALID' });
    expect(neverInvoke).not.toHaveBeenCalled();
  });
});
