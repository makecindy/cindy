import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCachedRenderItems, buildRenderItems } from '@/components/chat/MessageStream';
import { extractAnchorCardId, extractGhostCardId, extractToolResultMedia } from '@/components/chat/AgentActionRow';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { GhostCardSnapshot, GhostCardEntry } from '@/cindy-brain/ghostCardStore';

beforeEach(() => setDataOwnerGeneration('cache-test'));
afterEach(() => vi.restoreAllMocks());

describe('tool result metadata reuse', () => {
  it('parses once across media/card/anchor consumers and refreshes changed content', () => {
    const content = JSON.stringify({ xdt_card_id: 'one', xdt_anchor_card_id: 'anchor', xdt_image_url: 'cindy-media://one.png' });
    const parse = vi.spyOn(JSON, 'parse');
    expect(extractGhostCardId(content)).toBe('one');
    expect(extractAnchorCardId(content)).toBe('anchor');
    const media = extractToolResultMedia(content);
    expect(media).toHaveLength(1);
    media.pop();
    expect(extractToolResultMedia(content)).toHaveLength(1);
    expect(parse.mock.calls.filter(([text]) => text === content)).toHaveLength(1);
    expect(extractGhostCardId(content.replace('one', 'two'))).toBe('two');
  });

  it('caches malformed negative results and expires on owner changes', () => {
    const content = '{ invalid xdt_card_id';
    const parse = vi.spyOn(JSON, 'parse');
    expect(extractGhostCardId(content)).toBeNull();
    expect(extractToolResultMedia(content)).toEqual([]);
    expect(parse.mock.calls.filter(([text]) => text === content)).toHaveLength(1);
    setDataOwnerGeneration('another-owner');
    expect(extractGhostCardId(content)).toBeNull();
    expect(parse.mock.calls.filter(([text]) => text === content)).toHaveLength(2);
  });

  it('evicts old entries by count and total retained text', () => {
    const oldest = '{"xdt_card_id":"old"}';
    const parse = vi.spyOn(JSON, 'parse');
    extractGhostCardId(oldest);
    for (let i = 0; i < 512; i++) extractGhostCardId(`{"xdt_card_id":"${i}"}`);
    extractGhostCardId(oldest);
    expect(parse.mock.calls.filter(([text]) => text === oldest)).toHaveLength(2);
    for (let i = 0; i < 3; i++) extractGhostCardId(String(i) + ' '.repeat(12 * 1024 * 1024));
    extractGhostCardId(oldest);
    expect(parse.mock.calls.filter(([text]) => text === oldest)).toHaveLength(3);
  });

  it('does not retain oversized results and preserves literal-token compatibility', () => {
    const content = JSON.stringify({ xdt_card_id: 'large', text: ' '.repeat(32 * 1024 * 1024) });
    const parse = vi.spyOn(JSON, 'parse');
    expect(extractGhostCardId(content)).toBe('large');
    expect(extractGhostCardId(content)).toBe('large');
    expect(parse.mock.calls.filter(([text]) => text === content)).toHaveLength(2);
    expect(extractGhostCardId('{"xdt_\\u0063ard_id":"escaped","xdt_image_url":"cindy-media://one.png"}')).toBeNull();
  });
});

const rows = (id: string): ChatMessage[] => [{ clientId: id, role: 'assistant', content: id }];

describe('history projection across message-view mounts', () => {
  it('reuses recent projections, evicts the least recent and clears on owner change', () => {
    const a = rows('a'), b = rows('b'), c = rows('c'), d = rows('d');
    const first = buildCachedRenderItems(a);
    const second = buildCachedRenderItems(b);
    buildCachedRenderItems(c);
    expect(buildCachedRenderItems(a)).toBe(first);
    buildCachedRenderItems(d);
    expect(buildCachedRenderItems(a)).toBe(first);
    expect(buildCachedRenderItems(b)).not.toBe(second);
    setDataOwnerGeneration('another-owner');
    expect(buildCachedRenderItems(a)).not.toBe(first);
  });

  it('invalidates every semantic builder input but not a per-mount parser cache', () => {
    const messages = rows('a');
    const tasks = new Map();
    const ghost: GhostCardSnapshot = { version: 0, byCallId: new Map(), liveCards: [] };
    const options = { historyWindowIncomplete: false, workingDir: '/a', botSessionId: 'a', turnChangeSets: [] };
    const first = buildCachedRenderItems(messages, tasks, ghost, options);
    expect(buildCachedRenderItems(messages, tasks, ghost, { ...options, markdownImageTargetCache: new Map() })).toBe(first);
    for (const changed of [
      { ...options, historyWindowIncomplete: true }, { ...options, workingDir: '/b' },
      { ...options, botSessionId: 'b' }, { ...options, turnChangeSets: [] },
    ]) {
      const base = buildCachedRenderItems(messages, tasks, ghost, options);
      expect(buildCachedRenderItems(messages, tasks, ghost, changed)).not.toBe(base);
    }
    const base = buildCachedRenderItems(messages, tasks, ghost, options);
    expect(buildCachedRenderItems(messages, new Map(), ghost, options)).not.toBe(base);
    expect(buildCachedRenderItems([...messages], tasks, ghost, options)).not.toBe(base);
    expect(buildCachedRenderItems([{ ...messages[0], isStreaming: true }], tasks, ghost, options)).not.toBe(base);
  });

  it('updates card fallback when a new snapshot shares the mutated card Map', () => {
    const messages: ChatMessage[] = [
      { clientId: 'call', role: 'tool_use', content: '', toolUseId: 't', toolName: 'mcp__cindy__ghost_call', toolInput: { ghost_id: 'art' } },
      { clientId: 'result', role: 'tool_result', toolUseId: 't', content: '{"xdt_card_id":"card","xdt_image_url":"cindy-media://one.png"}' },
    ];
    const byCallId = new Map<string, GhostCardEntry>([['card', { status: 'missing' }]]);
    const snapshot: GhostCardSnapshot = { version: 0, byCallId, liveCards: [] };
    const first = buildCachedRenderItems(messages, undefined, snapshot);
    expect(first.items.some((item) => item.type === 'tool_media')).toBe(true);
    byCallId.set('card', { status: 'ready', ghostId: 'art', html: '<p>ready</p>', height: 100 });
    const nextSnapshot = { ...snapshot, version: 1 };
    const next = buildCachedRenderItems(messages, undefined, nextSnapshot);
    expect(next).not.toBe(first);
    expect(next).toEqual(buildRenderItems(messages, undefined, nextSnapshot));
    expect(next.items.some((item) => item.type === 'ghost_card')).toBe(true);
    expect(next.items.some((item) => item.type === 'tool_media')).toBe(false);
  });
});
