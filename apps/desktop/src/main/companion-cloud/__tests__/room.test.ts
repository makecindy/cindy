import { describe, expect, it } from 'vitest';
import { ROOM_HISTORY_MAX_PAGES, readAllRoomMessages, transcriptPageOf } from '../room.js';
import type { CompanionTranscriptMessage } from '../../../shared/companionCloud.js';
import { fakeApi } from './fakes.js';

const message = (seq: number, createdAt: number, author = 'human') => ({
  id: `m${seq}`, seq: String(seq), authorId: author, createdAt: new Date(createdAt).toISOString(), content: [{ type: 'text', text: `t${seq}` }],
});

describe('reading the whole room', () => {
  it('pages through every message and orders by message time, not arrival', async () => {
    // Seq 101..200 arrived later but are older history (uploaded by a backfill).
    const room = [...Array.from({ length: 100 }, (_, i) => message(i + 1, 10_000 + i)),
      ...Array.from({ length: 100 }, (_, i) => message(i + 101, 1_000 + i, 'bot'))];
    const { api } = fakeApi((route) => {
      const before = /before=(\d+)/.exec(route)?.[1];
      const older = room.filter(m => !before || BigInt(m.seq) < BigInt(before)).reverse();
      return older.slice(0, 100);
    });
    const all = await readAllRoomMessages(api, 'room', 'bot');
    expect(all).toHaveLength(200);
    expect(all[0]!.text).toBe('t101');
    expect(all.at(-1)!.text).toBe('t100');
    expect(all[0]!.role).toBe('assistant');
  });
});

describe('reading the whole room for a take-over or a merge', () => {
  const pages = (count: number) => fakeApi((route) => {
    // `count` full pages, newest first; seq counts down from count * 100.
    const before = Number(/before=(\d+)/.exec(route)?.[1] ?? count * 100 + 1);
    const top = before - 1;
    if (top < 1) return [];
    return Array.from({ length: Math.min(100, top) }, (_, i) => message(top - i, top - i));
  });

  it('reads past the view limit to the first message instead of stopping part way', async () => {
    const { api } = pages(ROOM_HISTORY_MAX_PAGES + 2);
    expect(await readAllRoomMessages(api, 'room', 'bot')).toHaveLength(ROOM_HISTORY_MAX_PAGES * 100);
    expect(await readAllRoomMessages(api, 'room', 'bot', { complete: true })).toHaveLength((ROOM_HISTORY_MAX_PAGES + 2) * 100);
  });

  it('fails instead of reading forever when the cursor does not move', async () => {
    const stuck = Array.from({ length: 100 }, (_, i) => message(500 - i, 500 - i));
    const { api } = fakeApi(() => stuck);
    await expect(readAllRoomMessages(api, 'room', 'bot', { complete: true })).rejects.toThrow('ROOM_HISTORY_STALLED');
  });
});

describe('transcript pages', () => {
  const at = (createdAt: number, n: number): CompanionTranscriptMessage => ({ id: `x${n}`, seq: String(n), role: 'user', text: `${n}`, createdAt });

  it('returns the latest page and a cursor for older messages, keeping equal times together', () => {
    // 102 messages; the 100-message boundary falls between two that share a time: both stay.
    const messages = Array.from({ length: 102 }, (_, i) => at(i === 2 ? 1 : i, i));
    const first = transcriptPageOf(messages);
    expect(first.messages).toHaveLength(101);
    expect(first.messages[0]!.text).toBe('1');
    expect(first.nextBefore).toBe('1');
    expect(transcriptPageOf(messages, 1).messages.map(m => m.text)).toEqual(['0']);
    const short = transcriptPageOf(Array.from({ length: 150 }, (_, i) => at(i + 1, i + 1)));
    expect(short.messages).toHaveLength(100);
    expect(short.nextBefore).toBe('51');
    expect(transcriptPageOf(Array.from({ length: 150 }, (_, i) => at(i + 1, i + 1)), 51).messages.map(m => m.text).at(-1)).toBe('50');
  });
});
