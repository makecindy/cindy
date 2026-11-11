import { describe, expect, it, vi } from 'vitest';

import type { AttachedFile } from '@/lib/fileTypes';
import {
  botGroupAttachmentScope,
  botGroupAttachmentSignature,
  refreshPendingBotGroupAttachments,
  botGroupAttachmentRows,
  toBotGroupAttachmentInputs,
} from '../botGroupAttachments';
import type { BotGroupAttachment, BotGroupMessageView } from '../../../../shared/botGroupChat';

function attached(overrides: Partial<AttachedFile>): AttachedFile {
  return {
    id: 'f1',
    name: 'photo.png',
    path: '/tmp/photo.png',
    ext: '.png',
    size: 12,
    category: 'image',
    mimeType: 'image/png',
    ...overrides,
  };
}

describe('botGroupAttachments', () => {
  it('scopes a group’s tray apart from any task id', () => {
    expect(botGroupAttachmentScope('g1')).toBe('bot-group:g1');
  });

  it('hands main the serialized shape without inline bytes or annotation strokes', () => {
    const inputs = toBotGroupAttachmentInputs([
      attached({
        url: 'cindy-media://blobs/burned.png',
        name: 'photo-annotated.png',
        originalName: 'photo-annotated.png',
        annotated: true,
        annotationStrokes: [{ points: [{ x: 0, y: 0 }] }],
        annotationSourceUrl: 'cindy-media://blobs/original.png',
        annotationRegions: [{ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }],
      }),
      attached({ id: 'f2', name: 'notes.md', path: '/tmp/notes.md', ext: '.md', category: 'text', mimeType: 'text/plain' }),
    ]);
    expect(inputs).toEqual([
      {
        id: 'f1',
        name: 'photo-annotated.png',
        path: '/tmp/photo.png',
        ext: '.png',
        size: 12,
        category: 'image',
        mimeType: 'image/png',
        url: 'cindy-media://blobs/burned.png',
        originalName: 'photo-annotated.png',
        annotated: true,
      },
      {
        id: 'f2',
        name: 'notes.md',
        path: '/tmp/notes.md',
        ext: '.md',
        size: 12,
        category: 'text',
        mimeType: 'text/plain',
        originalName: 'notes.md',
      },
    ]);
  });

  it('changes the send signature when the files or their annotations change', () => {
    const base = [attached({ url: 'cindy-media://blobs/a.png' })];
    const same = [attached({ url: 'cindy-media://blobs/a.png' })];
    const drawn = [attached({ url: 'cindy-media://blobs/a.png', annotationStrokes: [{ points: [{ x: 1, y: 1 }] }] })];
    expect(botGroupAttachmentSignature(same)).toBe(botGroupAttachmentSignature(base));
    expect(botGroupAttachmentSignature(drawn)).not.toBe(botGroupAttachmentSignature(base));
    expect(botGroupAttachmentSignature([])).not.toBe(botGroupAttachmentSignature(base));
  });

  // The flattened rows are the attachments in sent order, whatever each one is drawn as.
  const order = (rows: ReturnType<typeof botGroupAttachmentRows>) =>
    rows.flatMap((row) => row.kind === 'picture' ? [row.slot] : row.slots)
      .map((slot) => slot.kind === 'pending' ? `${slot.attachment.id}:${slot.state}` : `${slot.attachment.id}:${slot.kind}`);

  it('draws each attachment as what it is, in the order it was sent; only neighbouring chips share a row', () => {
    const rows = botGroupAttachmentRows([
      { id: 'a', name: 'report.pdf', category: 'pdf', mimeType: 'application/pdf', size: 1, url: null, path: '/tmp/report.pdf' },
      { id: 'b', name: 'photo.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/b.png', path: null },
      { id: 'c', name: 'c.mp4', category: 'file', mimeType: 'video/mp4', size: 1, url: null, path: '/tmp/c.mp4' },
      { id: 'd', name: 'd.pdf', category: 'pdf', mimeType: 'application/pdf', size: 1, url: null, path: null },
      { id: 'e', name: 'shot.PNG', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' },
    ]);
    // A PDF with neither address nor path is not silently dropped.
    expect(order(rows)).toEqual(['a:file', 'b:image', 'c:file', 'd:unavailable', 'e:loading']);
    expect(rows.map((row) => row.kind === 'picture' ? row.slot.attachment.id : row.slots.map((slot) => slot.attachment.id).join('+')))
      .toEqual(['a', 'b', 'c+d', 'e']);
  });

  it('keeps every attachment at its sent position through any arrival order and outcome', () => {
    const names = ['report.pdf', 'photo.png', 'notes.md', 'shot.jpg', 'mock.png'];
    // What each one turns out to be once it arrives; the `.png` step artifact is a plain file.
    const arrived: BotGroupAttachment[] = [
      { id: '0', name: names[0]!, category: 'pdf', mimeType: 'application/pdf', size: 1, url: null, path: '/tmp/0' },
      { id: '1', name: names[1]!, category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/1.png', path: null },
      { id: '2', name: names[2]!, category: 'text', mimeType: 'text/markdown', size: 1, url: null, path: '/tmp/2' },
      { id: '3', name: names[3]!, category: 'image', mimeType: 'image/jpeg', size: 1, url: 'cindy-media://blobs/3.jpg', path: null },
      { id: '4', name: names[4]!, category: 'file', mimeType: 'application/octet-stream', size: 1, url: null, path: '/tmp/4' },
    ];
    const pending = (attachment: BotGroupAttachment, state: 'loading' | 'unavailable'): BotGroupAttachment =>
      ({ ...attachment, category: 'file', mimeType: '', size: 0, url: null, path: null, state });
    // Every combination of not-yet / failed / arrived for the five slots.
    for (let mask = 0; mask < 3 ** arrived.length; mask += 1) {
      const view = arrived.map((attachment, index) => {
        const state = Math.floor(mask / 3 ** index) % 3;
        return state === 0 ? pending(attachment, 'loading') : state === 1 ? pending(attachment, 'unavailable') : attachment;
      });
      expect(order(botGroupAttachmentRows(view)).map((entry) => entry.split(':')[0])).toEqual(['0', '1', '2', '3', '4']);
    }
  });
});

describe('refreshPendingBotGroupAttachments', () => {
  const loading = (id: string): BotGroupAttachment => ({ id, name: `${id}.png`, category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' });
  const ready = (id: string): BotGroupAttachment => ({ id, name: `${id}.png`, category: 'image', mimeType: 'image/png', size: 1, url: `cindy-media://blobs/${id}.png`, path: null });
  const message = (sequence: number, attachments: BotGroupAttachment[] = []) => ({
    id: `m${sequence}`, sequence, kind: 'message', authorKind: 'user', authorBotId: null, authorName: '', content: '',
    mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], attachments, createdAt: sequence,
  }) as BotGroupMessageView;

  it('re-reads the earlier pages that still hold loading attachments and only swaps loaded messages', async () => {
    const loaded = [message(10, [loading('old')]), message(11), message(200, [loading('other')]), message(201), message(400, [loading('latest')])];
    const reads: number[] = [];
    const refreshed = await refreshPendingBotGroupAttachments(loaded, 400, async (before) => {
      reads.push(before);
      // Each page is the 100 messages before `before`; the second one also reaches unloaded history.
      return before === 201 ? [message(150), message(200, [ready('other')])] : [message(5), message(10, [ready('old')])];
    });
    expect(reads).toEqual([201, 11]);
    expect(refreshed?.map((m) => m.sequence)).toEqual([10, 11, 200, 201, 400]);
    expect(refreshed?.find((m) => m.sequence === 10)?.attachments[0]).toMatchObject({ id: 'old', url: 'cindy-media://blobs/old.png' });
    expect(refreshed?.find((m) => m.sequence === 200)?.attachments[0]).toMatchObject({ id: 'other', category: 'image' });
    // The page just read is left alone, even while its attachment is still loading.
    expect(refreshed?.find((m) => m.sequence === 400)?.attachments[0]?.state).toBe('loading');
  });

  it('covers every loading page of the loaded set in one round, however many there are', async () => {
    const sequences = [600, 500, 400, 300, 200, 100];
    const loaded = [...sequences.map((sequence) => message(sequence, [loading(`a${sequence}`)])).reverse(), message(700)];
    const reads: number[] = [];
    const refreshed = await refreshPendingBotGroupAttachments(loaded, 700, async (before) => {
      reads.push(before);
      return [message(before - 1, [ready(`a${before - 1}`)])];
    });
    expect(reads).toEqual([601, 501, 401, 301, 201, 101]);
    expect(refreshed?.every((m) => m.attachments.every((attachment) => !attachment.state))).toBe(true);
  });

  it('still ends, at most one read per loading message, when a page never reaches it', async () => {
    const read = vi.fn(async () => [message(50)]);
    const kept = await refreshPendingBotGroupAttachments([message(10, [loading('x')]), message(20, [loading('y')])], 99, read);
    expect(read.mock.calls).toEqual([[21], [11]]);
    expect(kept?.map((m) => m.attachments[0]?.state)).toEqual(['loading', 'loading']);
  });

  it('also re-reads a page whose attachment failed, so a later read can retry it', async () => {
    const failed: BotGroupAttachment = { ...loading('gone'), state: 'unavailable' };
    const refreshed = await refreshPendingBotGroupAttachments([message(10, [failed]), message(11)], 99, async (before) => {
      expect(before).toBe(11);
      return [message(10, [ready('gone')])];
    });
    expect(refreshed?.[0]?.attachments[0]).toMatchObject({ id: 'gone', category: 'image' });
  });

  it('reads nothing when no earlier message is still loading, and stops on a failed read', async () => {
    const read = vi.fn(async () => null);
    expect(await refreshPendingBotGroupAttachments([message(1), message(9, [loading('x')])], 9, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const kept = await refreshPendingBotGroupAttachments([message(1, [loading('x')])], 9, read);
    expect(read).toHaveBeenCalledOnce();
    expect(kept?.[0]?.attachments[0]?.state).toBe('loading');
  });
});
