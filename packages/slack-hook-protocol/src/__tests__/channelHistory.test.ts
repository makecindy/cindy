import { describe, expect, it } from 'vitest';
import {
  channelHistoryTime,
  selectChannelHistory,
  truncateChannelHistory,
} from '../channelHistory';

const options = {
  id: (x: { id: string; text: string }) => x.id,
  render: (x: { text: string }) => x.text,
};
describe('channel history selection', () => {
  it('keeps the recent fifty, preserves chronological order, and deduplicates IDs', () => {
    const items = Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: `message ${i}` }));
    const result = selectChannelHistory([...items, items[69]], options);
    expect(result.entries.map(({ item }) => item.id)).toEqual(items.slice(20).map((x) => x.id));
    expect(result.truncated).toBe(true);
  });
  it('retains an old explicit quote ahead of newer history without repeating it', () => {
    const items = Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: `message ${i}` }));
    const result = selectChannelHistory(items, { ...options, priorityId: '0' });
    expect(result.entries[0].item.id).toBe('0');
    expect(result.entries.at(-1)?.item.id).toBe('69');
    expect(result.entries).toHaveLength(50);
    expect(result.entries.filter(({ item }) => item.id === '0')).toHaveLength(1);
  });
  it('counts separators, retains the newest text and marks partial bodies within the budget', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: id.repeat(4000) }));
    const result = selectChannelHistory(items, options);
    expect(result.entries.map(({ text }) => text).join('\n').length).toBeLessThanOrEqual(16000);
    expect(result.entries.at(-1)?.text).toBe('e'.repeat(4000));
    expect(result.entries[0].text).toContain('[…已截断]');
    expect(result.entries.some(({ item }) => item.id === 'a')).toBe(false);
    expect(selectChannelHistory(items, { ...options, maxMessages: 0 }).entries).toEqual([]);
  });
  it('marks single-body truncation and provides explicit UTC or unknown time', () => {
    expect(truncateChannelHistory('x'.repeat(5000))).toHaveLength(4000);
    expect(truncateChannelHistory('x'.repeat(5000))).toContain('[…已截断]');
    expect(channelHistoryTime(Date.UTC(2026, 10, 7, 8, 9))).toBe('2026-11-07 08:09 UTC');
    expect(channelHistoryTime(Number.MAX_VALUE)).toBe('[时间未知]');
  });
});
