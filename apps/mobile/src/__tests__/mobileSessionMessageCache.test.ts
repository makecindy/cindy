import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteMessage } from '@/session/types';

// 内存版 AsyncStorage:覆盖 getItem/setItem/removeItem/getAllKeys/multiRemove,贴近真实 RN API。
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

function makeMessage(overrides: Partial<RemoteMessage> & { createdAt: string }): RemoteMessage {
  return {
    id: overrides.id ?? `m-${overrides.createdAt}`,
    clientId: overrides.clientId ?? '',
    sessionId: overrides.sessionId ?? 'session-1',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? 'hello',
    toolUseId: overrides.toolUseId ?? null,
    agentMeta: overrides.agentMeta ?? null,
    createdAt: overrides.createdAt,
    ...(overrides.systemCardType ? { systemCardType: overrides.systemCardType } : {}),
    ...(overrides.systemCardData ? { systemCardData: overrides.systemCardData } : {}),
  };
}

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

describe('mobileSessionMessageCache', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips cached messages for a (host, session) sorted oldest-first', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    await cacheSessionMessages('host-a', 'session-1', [
      makeMessage({ id: 'b', createdAt: isoAt(2), content: 'second' }),
      makeMessage({ id: 'a', createdAt: isoAt(1), content: 'first' }),
    ]);

    const cached = await getCachedSessionMessages('host-a', 'session-1');
    expect(cached.map((m) => m.id)).toEqual(['a', 'b']);
    expect(cached[0].content).toBe('first');
    expect(cached[1].content).toBe('second');
  });

  it('returns [] for missing cache or blank ids', async () => {
    const { getCachedSessionMessages, cacheSessionMessages } = await import('@/session/mobileSessionMessageCache');

    await expect(getCachedSessionMessages('host-a', 'session-x')).resolves.toEqual([]);
    await expect(getCachedSessionMessages('', 'session-1')).resolves.toEqual([]);
    // 空 deviceId/sessionId 不应写入任何 key。
    await cacheSessionMessages('', 'session-1', [makeMessage({ id: 'a', createdAt: isoAt(1) })]);
    expect(store.size).toBe(0);
  });

  it('preserves every original field (incl. non-typed) so cached deep-equals fresh', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    // fresh listMessages 可能带 interface 之外的字段(updatedAt/userId 等);缓存必须原样保留,
    // 否则 store 的逐 key 比较永远不等、每次开会话都重渲染(闪一下)。
    const fresh = {
      ...makeMessage({ id: 'a', createdAt: isoAt(1), content: 'body text' }),
      updatedAt: isoAt(1),
      userId: 'u-1',
      extra: { nested: true },
    } as unknown as RemoteMessage;

    await cacheSessionMessages('host-a', 'session-1', [fresh]);
    const cached = await getCachedSessionMessages('host-a', 'session-1');

    expect(cached).toHaveLength(1);
    // 内容字段未被改动,缓存消息与 fresh 逐字段一致(JSON 判等)。
    expect(JSON.stringify(cached[0])).toBe(JSON.stringify(fresh));
  });

  it('cached messages stay store-equal to fresh so no cached→fresh re-render fires', async () => {
    // 端到端复现"开会话不再闪":hydrate 缓存 → fresh 窗口回来 → store 经 remoteMessageListsEqual
    // 判等 → 不 bump messageVersion → 不 emit → 不重渲染。覆盖典型「会话」(纯文本 + 结构化 content +
    // JSON 字符串用户消息 + interface 之外的 wire 字段 + null/对象字段),不含 base64。
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');
    const { remoteSessionStore } = await import('@/session/remoteSessionStore');

    const fresh = [
      {
        ...makeMessage({ id: 'u1', clientId: 'c-u1', role: 'user', createdAt: isoAt(1) }),
        content: JSON.stringify({ text: '看下这个任务', images: [], files: [] }),
        updatedAt: isoAt(1),
        userId: 'user-1',
      },
      {
        ...makeMessage({ id: 'a1', role: 'assistant', createdAt: isoAt(2) }),
        content: { type: 'text', text: '好的,这是一段较长的普通回复内容。'.repeat(20) },
        agentMeta: { turnCostUsd: 0.0123, turnCostIsEstimate: false },
        updatedAt: isoAt(2),
      },
      {
        ...makeMessage({ id: 't1', role: 'tool_use', createdAt: isoAt(3), toolUseId: 'tool-1' }),
        content: { name: 'Read', input: { file_path: '/tmp/x.ts' } },
        updatedAt: isoAt(3),
      },
    ] as unknown as RemoteMessage[];

    await cacheSessionMessages('host-a', 'session-eq', fresh);
    const cached = await getCachedSessionMessages('host-a', 'session-eq');

    remoteSessionStore.clear();
    remoteSessionStore.hydrateMessagesIfEmpty('session-eq', cached);
    const versionAfterHydrate = remoteSessionStore.getMessageVersion();

    // fresh listMessages 窗口回来(同一批消息)。若缓存对 fresh 保真,这一步应短路、不 bump。
    remoteSessionStore.setLatestMessageWindow('session-eq', fresh);
    expect(remoteSessionStore.getMessageVersion()).toBe(versionAfterHydrate);

    // setMessages(replaceMessages 路径)同样应判等短路。
    remoteSessionStore.setMessages('session-eq', fresh);
    expect(remoteSessionStore.getMessageVersion()).toBe(versionAfterHydrate);
  });

  it('keeps structured content verbatim when it has no heavy blobs', async () => {
    const { __testing } = await import('@/session/mobileSessionMessageCache');

    const content = {
      text: 'look at this',
      images: [{ url: 'https://cdn.example.com/a.png', name: 'a.png', mimeType: 'image/png' }],
      files: [{ name: 'doc.txt', path: '/tmp/doc.txt' }],
    };
    const sanitized = __testing.sanitizeContentForCache(content);
    // 无 base64 → 原样保留,与原 content JSON 完全一致(保 cached==fresh 短路)。
    expect(JSON.stringify(sanitized)).toBe(JSON.stringify(content));
  });

  it('strips base64 from image attachments but keeps url metadata', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    const content = {
      text: 'with image',
      images: [{
        url: 'https://cdn.example.com/big.png',
        name: 'big.png',
        mimeType: 'image/png',
        base64: 'AAAA'.repeat(5000),
      }],
    };
    await cacheSessionMessages('host-a', 'session-1', [
      makeMessage({ id: 'img', createdAt: isoAt(1), content }),
    ]);

    const cached = await getCachedSessionMessages('host-a', 'session-1');
    const cachedContent = cached[0].content as { text: string; images: Array<Record<string, unknown>> };
    expect(cachedContent.text).toBe('with image');
    expect(cachedContent.images[0].url).toBe('https://cdn.example.com/big.png');
    expect(cachedContent.images[0].name).toBe('big.png');
    expect(cachedContent.images[0].base64).toBeUndefined();
    // 缓存条目体积应远小于内联 base64 的原始体积。
    const raw = store.get([...store.keys()][0]!)!;
    expect(raw.includes('AAAA')).toBe(false);
  });

  it('drops inline base64 data URIs from content strings', async () => {
    const { __testing } = await import('@/session/mobileSessionMessageCache');
    const dataUri = `data:image/png;base64,${'Z'.repeat(40_000)}`;
    expect(__testing.sanitizeContentForCache(dataUri)).toBe('');
    const nested = __testing.sanitizeContentForCache({ images: [{ uri: dataUri }] }) as { images: Array<Record<string, unknown>> };
    expect(nested.images[0].uri).toBe('');
  });

  it('shrinks a large base64-bearing JSON string but keeps non-base64 fields', async () => {
    const { __testing } = await import('@/session/mobileSessionMessageCache');
    const jsonString = JSON.stringify({
      text: 'hi',
      images: [{ url: 'https://cdn.example.com/x.png', base64: 'Q'.repeat(40_000) }],
    });
    const sanitized = __testing.sanitizeContentForCache(jsonString) as string;
    expect(typeof sanitized).toBe('string');
    expect(sanitized.includes('base64')).toBe(false);
    expect(sanitized.includes('https://cdn.example.com/x.png')).toBe(true);
    expect(sanitized.length).toBeLessThan(jsonString.length);
  });

  it('caps the retained messages to the newest MAX_CACHED_SESSION_MESSAGES', async () => {
    const { MAX_CACHED_SESSION_MESSAGES, cacheSessionMessages, getCachedSessionMessages } =
      await import('@/session/mobileSessionMessageCache');

    const total = MAX_CACHED_SESSION_MESSAGES + 8;
    const messages = Array.from({ length: total }, (_, index) =>
      makeMessage({ id: `m-${index}`, createdAt: isoAt(index) }));
    await cacheSessionMessages('host-a', 'session-1', messages);

    const cached = await getCachedSessionMessages('host-a', 'session-1');
    expect(cached).toHaveLength(MAX_CACHED_SESSION_MESSAGES);
    expect(cached[0].id).toBe(`m-${total - MAX_CACHED_SESSION_MESSAGES}`);
    expect(cached[cached.length - 1].id).toBe(`m-${total - 1}`);
    expect(cached.some((m) => m.id === 'm-0')).toBe(false);
  });

  it('isolates caches per (host, session) so multi-device does not bleed', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    await cacheSessionMessages('host-a', 'session-1', [makeMessage({ id: 'a1', createdAt: isoAt(1), content: 'A' })]);
    await cacheSessionMessages('host-b', 'session-1', [makeMessage({ id: 'b1', createdAt: isoAt(1), content: 'B' })]);

    const a = await getCachedSessionMessages('host-a', 'session-1');
    const b = await getCachedSessionMessages('host-b', 'session-1');
    expect(a.map((m) => m.id)).toEqual(['a1']);
    expect(b.map((m) => m.id)).toEqual(['b1']);
    expect(a[0].content).toBe('A');
    expect(b[0].content).toBe('B');
  });

  it('dedupes by message key (id) keeping the last occurrence', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    await cacheSessionMessages('host-a', 'session-1', [
      makeMessage({ id: 'dup', createdAt: isoAt(1), content: 'stale' }),
      makeMessage({ id: 'other', createdAt: isoAt(2), content: 'other' }),
      makeMessage({ id: 'dup', createdAt: isoAt(3), content: 'fresh' }),
    ]);

    const cached = await getCachedSessionMessages('host-a', 'session-1');
    expect(cached.filter((m) => m.id === 'dup')).toHaveLength(1);
    expect(cached.find((m) => m.id === 'dup')!.content).toBe('fresh');
  });

  it('writing an empty list clears the cache entry', async () => {
    const { cacheSessionMessages, getCachedSessionMessages } = await import('@/session/mobileSessionMessageCache');

    await cacheSessionMessages('host-a', 'session-1', [makeMessage({ id: 'a', createdAt: isoAt(1) })]);
    expect(store.size).toBe(1);
    await cacheSessionMessages('host-a', 'session-1', []);
    expect(store.size).toBe(0);
    await expect(getCachedSessionMessages('host-a', 'session-1')).resolves.toEqual([]);
  });

  it('does not persist an empty render snapshot before cache hydration finishes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/remoteSessionStore.ts'), 'utf8');
    expect(source).toContain('const hydrationReadyKeyRef = useRef<string | null>(null);');
    expect(source).toContain('if (hydrationReadyKeyRef.current !== key) return;');
    expect(source).toContain('if (deviceId) void cacheSessionMessages(deviceId, sessionId, next).catch(() => undefined);');
  });

  it('clears every cached session on logout but leaves unrelated keys', async () => {
    const { __testing, cacheSessionMessages, clearCachedSessionMessages, getCachedSessionMessages } =
      await import('@/session/mobileSessionMessageCache');

    await cacheSessionMessages('host-a', 'session-1', [makeMessage({ id: 'a', createdAt: isoAt(1) })]);
    await cacheSessionMessages('host-b', 'session-2', [makeMessage({ id: 'b', createdAt: isoAt(1) })]);
    store.set('xdt.unrelated.key', 'keep-me');

    await clearCachedSessionMessages();

    await expect(getCachedSessionMessages('host-a', 'session-1')).resolves.toEqual([]);
    await expect(getCachedSessionMessages('host-b', 'session-2')).resolves.toEqual([]);
    expect([...store.keys()].some((key) => key.startsWith(`${__testing.storageKeyPrefix}.`))).toBe(false);
    expect(store.get('xdt.unrelated.key')).toBe('keep-me');
  });
});
