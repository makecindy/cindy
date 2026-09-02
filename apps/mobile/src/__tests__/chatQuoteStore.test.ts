import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe('chatQuoteStore', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { __testing } = await import('@/session/chatQuoteStore');
    __testing.reset();
    store.clear();
  });

  it('appends quotes, notifies subscribers, and clears all at once', async () => {
    const { appendQuote, clearQuotes, getQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    const unsubscribe = subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));

    appendQuote('s1', { text: 'first' });
    appendQuote('s1', { text: 'second', sourcePath: 'docs/a.md' });
    expect(getQuotes('s1')).toEqual([
      { text: 'first' },
      { text: 'second', sourcePath: 'docs/a.md' },
    ]);
    expect(seen).toEqual([1, 2]);
    expect(getQuotes('s2')).toEqual([]);

    clearQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
    expect(seen).toEqual([1, 2, 0]);
    unsubscribe();
  });

  it('ignores empty-text quotes', async () => {
    const { appendQuote, getQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: '' });
    expect(getQuotes('s1')).toEqual([]);
  });

  it('persists after the debounce window and hydrates on cold start', async () => {
    vi.useFakeTimers();
    const { __testing, appendQuote } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'kept', sourcePath: 'src/x.ts', comment: 'first\nsecond' });
    vi.advanceTimersByTime(__testing.persistDebounceMs + 10);
    vi.useRealTimers();
    await flushMicrotasks();
    expect(JSON.parse(store.get(__testing.storageKeyForSession('s1')) ?? '[]')).toEqual([
      { text: 'kept', sourcePath: 'src/x.ts', comment: 'first\nsecond' },
    ]);

    // 冷启动:内存清空后 hydrate 从 AsyncStorage 回填并通知订阅方。
    __testing.reset();
    const { getQuotes, hydrateQuotes, subscribeQuotes } = await import('@/session/chatQuoteStore');
    const seen: number[] = [];
    subscribeQuotes('s1', () => seen.push(getQuotes('s1').length));
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([
      { text: 'kept', sourcePath: 'src/x.ts', comment: 'first\nsecond' },
    ]);
    expect(seen).toEqual([1]);
  });

  it('does not resurrect cleared quotes on hydrate (cleared marker wins)', async () => {
    const { __testing, appendQuote, clearQuotes, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), JSON.stringify([{ text: 'stale' }]));
    appendQuote('s1', { text: 'live' });
    clearQuotes('s1');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('setQuotes restores a snapshot (send-failure recovery) and empty array clears', async () => {
    const { appendQuote, clearQuotes, getQuotes, setQuotes } = await import('@/session/chatQuoteStore');
    appendQuote('s1', { text: 'a', comment: 'remember this' });
    const snapshot = [...getQuotes('s1')];
    clearQuotes('s1');
    setQuotes('s1', snapshot);
    expect(getQuotes('s1')).toEqual([{ text: 'a', comment: 'remember this' }]);
    setQuotes('s1', []);
    expect(getQuotes('s1')).toEqual([]);
  });

  it('preserves an ordered fork/rewind body only while visible text and quotes are unchanged', async () => {
    vi.useFakeTimers();
    const {
      __testing,
      hydrateQuotes,
      resolveOrderedQuoteDraft,
      setOrderedQuoteDraft,
      setQuotes,
    } = await import('@/session/chatQuoteStore');
    const quotes = [{ text: 'A' }, { text: 'B', sourcePath: 'docs/b.md' }];
    const orderedDraft = {
      encodedBody: [
        '> <!-- cindy-composer-quote -->',
        '> A',
        '',
        'reply A',
        '',
        '> <!-- cindy-composer-quote -->',
        '> B',
        '> — source: docs/b.md',
        '',
        'reply B',
      ].join('\n'),
      projectedText: 'reply A\n\nreply B',
    };

    setOrderedQuoteDraft('s1', quotes, orderedDraft);
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toEqual(orderedDraft);
    expect(resolveOrderedQuoteDraft('s1', 'edited', quotes)).toBeNull();
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, [quotes[1], quotes[0]])).toBeNull();
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, [
      { ...quotes[0], comment: 'new comment' },
      quotes[1],
    ])).toBeNull();

    // 发送失败期间新采集的引用不在原 encodedBody 里，必须丢弃旧顺序基线，
    // 否则重试会误命中并静默漏发 C。
    const expandedQuotes = [...quotes, { text: 'C' }];
    setOrderedQuoteDraft('s-extra', expandedQuotes, orderedDraft);
    expect(resolveOrderedQuoteDraft('s-extra', orderedDraft.projectedText, expandedQuotes)).toBeNull();

    vi.advanceTimersByTime(__testing.persistDebounceMs + 10);
    vi.useRealTimers();
    await flushMicrotasks();
    __testing.reset();
    await hydrateQuotes('s1');
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toEqual(orderedDraft);

    // 普通引用更新明确让旧顺序基线失效。
    setQuotes('s1', quotes);
    expect(resolveOrderedQuoteDraft('s1', orderedDraft.projectedText, quotes)).toBeNull();
  });

  it('drops malformed persisted payloads on hydrate', async () => {
    const { __testing, getQuotes, hydrateQuotes } = await import('@/session/chatQuoteStore');
    store.set(__testing.storageKeyForSession('s1'), '{"not":"an array"}');
    await hydrateQuotes('s1');
    expect(getQuotes('s1')).toEqual([]);
  });

  it('truncateQuoteText caps at QUOTE_MAX_CHARS with an ellipsis', async () => {
    const { QUOTE_MAX_CHARS, truncateQuoteText } = await import('@/session/chatQuoteStore');
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 20);
    const truncated = truncateQuoteText(long);
    expect(truncated).toHaveLength(QUOTE_MAX_CHARS + 1);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncateQuoteText('short')).toBe('short');
  });
});
