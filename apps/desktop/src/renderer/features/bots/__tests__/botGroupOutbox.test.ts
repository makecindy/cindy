import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachedFile } from '@/lib/fileTypes';
import type {
  BotGroupAttachment,
  BotGroupMessageView,
  BotGroupSendInput,
  BotGroupSendResult,
} from '../../../../shared/botGroupChat';
import {
  BOT_GROUP_GONE_RETRY_MS,
  beginBotGroupTimelineRead,
  botGroupSendSignature,
  discardBotGroupOutbox,
  editBotGroupSend,
  enqueueBotGroupSend,
  getBotGroupOutbox,
  getBotGroupOutboxClaims,
  noteBotGroupTimeline,
  registerBotGroupComposer,
  resetBotGroupOutboxForTests,
  getBotGroupOutboxPreviews,
  mergeBotGroupLocalAttachments,
  projectBotGroupOutbox,
  retryBotGroupSend,
  startBotGroupOutbox,
  type BotGroupOutboxDraft,
  type BotGroupOutboxSendInput,
} from '../botGroupOutbox';

const mocks = vi.hoisted(() => ({
  /** Data owner account (null = an auth boundary's fence); `generation` moves on same-owner repairs. */
  owner: 1 as number | null,
  generation: 0,
  send: vi.fn<(input: BotGroupSendInput) => Promise<BotGroupSendResult>>(),
  materialize: vi.fn(async (files: readonly AttachedFile[]) => [...files]),
  protectedUrls: [] as string[],
  cleanupStaged: vi.fn(),
  getBotGroup: vi.fn(),
  list: { groups: [] as Array<{ id: string }>, loaded: false },
  listListeners: new Set<() => void>(),
  storage: undefined as undefined | ((request: any) => Promise<any[]>),
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: mocks.owner === null ? null : `account-${mocks.owner}`, generation: mocks.generation }),
  isDataOwnerGenerationCurrent: (owner: { dataOwnerId: string | null; generation: number }) =>
    owner.dataOwnerId === (mocks.owner === null ? null : `account-${mocks.owner}`) && owner.generation === mocks.generation,
}));
vi.mock('../botGroupStore', () => ({
  botGroupApi: () => ({ sendBotGroupMessage: mocks.send, getBotGroup: mocks.getBotGroup, botGroupOutbox: mocks.storage }),
  getBotGroupListSnapshot: () => mocks.list,
  subscribeBotGroups: (listener: () => void) => {
    mocks.listListeners.add(listener);
    return () => mocks.listListeners.delete(listener);
  },
}));

/** The sidebar list re-read: these groups exist for the account. */
function listGroups(ids: string[]) {
  mocks.list = { groups: ids.map((id) => ({ id })), loaded: true };
  for (const listener of [...mocks.listListeners]) listener();
}
vi.mock('@/lib/annotationBurnIn', () => ({
  isAnnotationBurnInError: () => false,
  materializeAnnotatedAttachmentsForSend: (files: readonly AttachedFile[]) => mocks.materialize(files),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  setBotGroupOutboxAttachmentUrls: (urls: readonly string[]) => {
    mocks.protectedUrls = [...new Set(urls)].sort();
  },
}));
vi.mock('@/lib/chatAttachmentStageCleanup', () => ({
  cleanupStagedChatAttachmentFiles: (files: unknown) => mocks.cleanupStaged(files),
}));

/** A send main has not answered yet; the test decides when and how. */
function deferred() {
  let resolve!: (result: BotGroupSendResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<BotGroupSendResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A draft as the composer builds it; `input` fields and draft fields override separately. */
function draft(
  input: Partial<BotGroupOutboxSendInput> = {},
  overrides: Partial<Omit<BotGroupOutboxDraft, 'input'>> = {},
): BotGroupOutboxDraft {
  const full: BotGroupOutboxSendInput = {
    groupId: 'g1',
    clientId: 'c1',
    text: '你好',
    mentions: { all: false, botIds: [] },
    ...input,
  };
  return {
    input: full,
    signature: botGroupSendSignature(full, '[]'),
    draft: full.text,
    tracked: [],
    files: [],
    attachmentScope: `bot-group:${full.groupId}`,
    ...overrides,
  };
}

function msg(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm',
    sequence: 1,
    kind: 'message',
    authorKind: 'user',
    authorBotId: null,
    authorName: '',
    content: '',
    mentions: { all: false, botIds: [] },
    noticeCode: null,
    planId: null,
    files: [],
    attachments: [],
    createdAt: 1,
    isSelf: true,
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function visible(groupId: string, messages: BotGroupMessageView[]) {
  return project(groupId, messages).pending.map((entry) => `${entry.input.clientId}:${entry.status}`);
}

function project(groupId: string, messages: BotGroupMessageView[]) {
  return projectBotGroupOutbox(
    getBotGroupOutbox(groupId),
    messages,
    getBotGroupOutboxClaims(groupId),
    getBotGroupOutboxPreviews(groupId),
  );
}

beforeEach(() => {
  mocks.owner = 1;
  mocks.generation = 0;
  mocks.storage = undefined;
  mocks.send.mockReset();
  mocks.materialize.mockReset().mockImplementation(async (files: readonly AttachedFile[]) => [...files]);
  mocks.protectedUrls = [];
  mocks.cleanupStaged.mockReset();
  mocks.getBotGroup.mockReset().mockResolvedValue({ ok: true, group: {} });
  mocks.list = { groups: [], loaded: false };
  resetBotGroupOutboxForTests();
});

afterEach(() => {
  resetBotGroupOutboxForTests();
});

describe('botGroupOutbox', () => {
  it('shows a message at once and submits a group’s sends one after another', async () => {
    const first = deferred();
    const second = deferred();
    mocks.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    noteBotGroupTimeline('g1', [msg({ id: 'old', sequence: 3 })], beginBotGroupTimelineRead());

    enqueueBotGroupSend(draft({ clientId: 'c1', text: '一' }));
    enqueueBotGroupSend(draft({ clientId: 'c2', text: '二' }));
    expect(visible('g1', [])).toEqual(['c1:sending', 'c2:sending']);
    await flush();
    // The second waits for the first, so the server sees them in the order they were sent.
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({ groupId: 'g1', clientId: 'c1', text: '一' });

    first.resolve({ ok: true, messageId: 'm1' });
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1]![0]).toMatchObject({ clientId: 'c2', text: '二' });
    expect(visible('g1', [])).toEqual(['c1:sent', 'c2:sending']);
  });

  it('swaps a receipt for the real message whether the receipt or the re-read comes first, and ignores repeats', async () => {
    const pending = deferred();
    mocks.send.mockReturnValueOnce(pending.promise);
    noteBotGroupTimeline('g1', [msg({ id: 'old', sequence: 3, content: '你好' })], beginBotGroupTimelineRead());
    enqueueBotGroupSend(draft());
    await flush();

    // A push re-read lands before main answers: the copy after the baseline stands in for it,
    // while the earlier message with the same text does not.
    const real = msg({ id: 'm9', sequence: 4, content: '你好' });
    const reread = [msg({ id: 'old', sequence: 3, content: '你好' }), real];
    noteBotGroupTimeline('g1', reread, beginBotGroupTimelineRead());
    expect(visible('g1', [msg({ id: 'old', sequence: 3, content: '你好' })])).toEqual(['c1:sending']);
    expect(visible('g1', reread)).toEqual([]);

    pending.resolve({ ok: true, messageId: 'm9' });
    await flush();
    expect(visible('g1', reread)).toEqual([]);
    // The same receipt id read again (a duplicate push) settles the entry for good.
    const read = beginBotGroupTimelineRead();
    noteBotGroupTimeline('g1', reread, read);
    noteBotGroupTimeline('g1', reread, read);
    expect(getBotGroupOutbox('g1')).toEqual([]);
  });

  it('never lets a re-read hide a message that is not the one in flight', async () => {
    const first = deferred();
    const second = deferred();
    mocks.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    noteBotGroupTimeline('g1', [], beginBotGroupTimelineRead());
    enqueueBotGroupSend(draft({ clientId: 'c1', text: '好' }));
    enqueueBotGroupSend(draft({ clientId: 'c2', text: '好' }));
    await flush();
    first.resolve({ ok: true, messageId: 'm1' });
    await flush();

    // m1 belongs to c1's receipt; c2 (same text, now in flight) must stay visible.
    const timeline = [msg({ id: 'm1', sequence: 1, content: '好' })];
    noteBotGroupTimeline('g1', timeline, beginBotGroupTimelineRead());
    expect(visible('g1', timeline)).toEqual(['c2:sending']);
    // A queued message is never matched, nor a message from someone else.
    expect(visible('g1', [...timeline, msg({ id: 'x', sequence: 2, content: '好', isSelf: false })])).toEqual(['c2:sending']);

    second.resolve({ ok: true, messageId: 'm2' });
    await flush();
    expect(visible('g1', timeline)).toEqual(['c2:sent']);
    noteBotGroupTimeline('g1', [...timeline, msg({ id: 'm2', sequence: 2, content: '好' })], beginBotGroupTimelineRead());
    expect(getBotGroupOutbox('g1')).toEqual([]);
  });

  it('settles a receipt that a later read no longer shows on its page', async () => {
    const pending = deferred();
    mocks.send.mockReturnValueOnce(pending.promise);
    enqueueBotGroupSend(draft());
    await flush();
    const early = beginBotGroupTimelineRead();
    pending.resolve({ ok: true, messageId: 'm1' });
    await flush();
    // A read that started before the receipt cannot speak for it.
    noteBotGroupTimeline('g1', [], early);
    expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['sent']);
    // One that started after it can: the message is in history even when pushed off the page.
    noteBotGroupTimeline('g1', [msg({ id: 'later', sequence: 50, isSelf: false })], beginBotGroupTimelineRead());
    expect(getBotGroupOutbox('g1')).toEqual([]);
  });

  it('hands a failure back to an empty composer, otherwise keeps it for 重试 with the same clientId', async () => {
    const restore = vi.fn(() => false);
    const notifyFailed = vi.fn();
    registerBotGroupComposer('g1', { restore, notifyFailed });
    mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
    enqueueBotGroupSend(draft({ clientId: 'keep' }));
    await flush();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(notifyFailed).toHaveBeenCalledWith('bots.groupChat.composer.sendFailed');
    expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['failed']);
    // Nothing is sent again on its own.
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);

    mocks.send.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ ok: true, messageId: 'm1' });
    retryBotGroupSend('g1', 'keep');
    await flush();
    expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['failed']);
    retryBotGroupSend('g1', 'keep');
    await flush();
    expect(mocks.send.mock.calls.map(([input]) => input.clientId)).toEqual(['keep', 'keep', 'keep']);
    expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['sent']);

    // An empty composer takes the next failure back; the bubble goes away.
    restore.mockReturnValue(true);
    mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'MENTION_UNAVAILABLE', message: '' });
    enqueueBotGroupSend(draft({ clientId: 'back' }));
    await flush();
    expect(restore).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ clientId: 'back' }), status: 'failed' }),
    );
    expect(notifyFailed).toHaveBeenLastCalledWith('bots.groupChat.errors.mentionUnavailable');
    expect(getBotGroupOutbox('g1').map((entry) => entry.input.clientId)).toEqual(['keep']);
  });

  it('offers no 重试 when main refused the message itself: only 编辑 can change it', async () => {
    registerBotGroupComposer('g1', { restore: vi.fn(() => false), notifyFailed: vi.fn() });
    for (const errorCode of ['QUOTE_UNAVAILABLE', 'MENTION_UNAVAILABLE', 'INVALID_PARAMS', 'INVALID_ATTACHMENT', 'ATTACHMENT_TOO_LARGE'] as const) {
      mocks.send.mockReset().mockResolvedValueOnce({ ok: false, errorCode, message: '' });
      enqueueBotGroupSend(draft({ clientId: errorCode }));
      await flush();
      expect(getBotGroupOutbox('g1').find((entry) => entry.input.clientId === errorCode)).toMatchObject({ status: 'failed', retryable: false });
      retryBotGroupSend('g1', errorCode);
      await flush();
      expect(mocks.send).toHaveBeenCalledTimes(1);
    }
    // A failure that may pass later stays retryable.
    mocks.send.mockReset().mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR', message: '' });
    enqueueBotGroupSend(draft({ clientId: 'later' }));
    await flush();
    expect(getBotGroupOutbox('g1').find((entry) => entry.input.clientId === 'later')?.retryable).toBe(true);
  });

  it('edits a failed message only into a composer that accepts it', async () => {
    const restore = vi.fn(() => false);
    registerBotGroupComposer('g1', { restore, notifyFailed: vi.fn() });
    mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
    enqueueBotGroupSend(draft());
    await flush();
    expect(editBotGroupSend('g1', 'c1')).toBe(false);
    expect(getBotGroupOutbox('g1')).toHaveLength(1);
    restore.mockReturnValue(true);
    expect(editBotGroupSend('g1', 'c1')).toBe(true);
    expect(getBotGroupOutbox('g1')).toEqual([]);
  });

  it('keeps groups apart: another group’s composer never takes a failure', async () => {
    const otherRestore = vi.fn(() => true);
    registerBotGroupComposer('g2', { restore: otherRestore, notifyFailed: vi.fn() });
    const g1 = deferred();
    mocks.send.mockReturnValueOnce(g1.promise).mockResolvedValueOnce({ ok: true, messageId: 'g2-m' });
    enqueueBotGroupSend(draft({ groupId: 'g1', clientId: 'a' }));
    enqueueBotGroupSend(draft({ groupId: 'g2', clientId: 'b' }));
    await flush();
    // Groups do not queue behind each other.
    expect(mocks.send).toHaveBeenCalledTimes(2);
    g1.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });
    await flush();
    expect(otherRestore).not.toHaveBeenCalled();
    expect(visible('g1', [])).toEqual(['a:failed']);
    expect(visible('g2', [])).toEqual(['b:sent']);
  });

  it('drops late answers after the account changes or the group is deleted', async () => {
    const late = deferred();
    mocks.send.mockReturnValueOnce(late.promise);
    enqueueBotGroupSend(draft());
    await flush();
    mocks.owner = 2;
    late.resolve({ ok: true, messageId: 'm1' });
    await flush();
    expect(getBotGroupOutbox('g1')).toEqual([]);

    const gone = deferred();
    mocks.send.mockReturnValueOnce(gone.promise);
    enqueueBotGroupSend(draft({ clientId: 'c2' }));
    await flush();
    discardBotGroupOutbox('g1');
    gone.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });
    await flush();
    expect(getBotGroupOutbox('g1')).toEqual([]);
  });

  it('keeps the attachments with the message and sends them in the existing shape', async () => {
    mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' });
    const file = {
      id: 'f1',
      name: 'report.pdf',
      path: '/tmp/report.pdf',
      ext: '.pdf',
      size: 7,
      category: 'pdf',
      mimeType: 'application/pdf',
      type: 'file',
    } as unknown as AttachedFile;
    enqueueBotGroupSend(draft({ text: '' }, { files: [file] }));
    expect(getBotGroupOutbox('g1')[0]!.attachments).toEqual([
      expect.objectContaining({ id: 'f1', name: 'report.pdf', category: 'pdf', path: '/tmp/report.pdf' }),
    ]);
    await flush();
    expect(mocks.send.mock.calls[0]![0].attachments).toEqual([
      expect.objectContaining({ name: 'report.pdf', path: '/tmp/report.pdf', category: 'pdf' }),
    ]);
  });

  it('sends the whole input it was given, first time and on 重试, without dropping fields it does not know', async () => {
    // A field a later composer feature adds (here a stand-in) must survive the outbox untouched.
    const extra = { replyTo: { messageId: 'root-1' } } as unknown as Partial<BotGroupOutboxSendInput>;
    mocks.send
      .mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' })
      .mockResolvedValueOnce({ ok: true, messageId: 'm1' });
    enqueueBotGroupSend(draft({ division: true, mentions: { all: true, botIds: ['a'] }, ...extra }));
    await flush();
    retryBotGroupSend('g1', 'c1');
    await flush();
    const expected = {
      groupId: 'g1',
      clientId: 'c1',
      text: '你好',
      mentions: { all: true, botIds: ['a'] },
      division: true,
      replyTo: { messageId: 'root-1' },
    };
    expect(mocks.send.mock.calls.map(([input]) => input)).toEqual([expected, expected]);
  });

  it('ties a clientId to every send field except itself, plus the attachments', () => {
    const base = draft().input;
    const same = botGroupSendSignature({ ...base, clientId: 'other' }, '[]');
    expect(same).toBe(botGroupSendSignature(base, '[]'));
    for (const changed of [
      { ...base, text: '别的' },
      { ...base, mentions: { all: false, botIds: ['a'] } },
      { ...base, division: true },
      { ...base, replyTo: 'x' } as unknown as BotGroupOutboxSendInput,
    ]) {
      expect(botGroupSendSignature(changed, '[]')).not.toBe(same);
    }
    expect(botGroupSendSignature(base, '[["f1"]]')).not.toBe(same);
  });

  describe('attachments of a confirmed message', () => {
    const local = (id: string, name: string): BotGroupAttachment => ({
      id, name, category: 'image', mimeType: 'image/png', size: 1, url: `cindy-media://blobs/${id}.png`, path: '/tmp/' + name,
    });
    /** A server copy not downloaded yet keeps id and name only. */
    const placeholder = (id: string, name: string): BotGroupAttachment => ({
      id, name, category: 'image', mimeType: 'image/png', size: 1, url: null, path: null,
    });
    const usable = (id: string, name: string): BotGroupAttachment => ({ ...placeholder(id, name), url: `cindy-media://blobs/${id}.png` });

    it('keeps each local preview until its server copy is usable, under the server id, in send order', () => {
      const mine = [local('l1', 'a.png'), local('l2', 'b.png')];
      // The server keeps the order the files were sent in.
      expect(mergeBotGroupLocalAttachments([placeholder('s1', 'a.png'), placeholder('s2', 'b.png')], mine)).toEqual([
        { ...mine[0], id: 's1' },
        { ...mine[1], id: 's2' },
      ]);
      expect(mergeBotGroupLocalAttachments([usable('s1', 'a.png'), placeholder('s2', 'b.png')], mine)).toEqual([
        usable('s1', 'a.png'),
        { ...mine[1], id: 's2' },
      ]);
      // Main leaves a copy out until it downloads: never show it missing or twice.
      expect(mergeBotGroupLocalAttachments([usable('s2', 'b.png')], mine)).toEqual([mine[0], usable('s2', 'b.png')]);
      // A burned-in image may come back renamed; equal counts pair the rest in order.
      expect(mergeBotGroupLocalAttachments([usable('s1', 'a-annotated.png'), usable('s2', 'b.png')], mine)).toEqual([
        usable('s1', 'a-annotated.png'),
        usable('s2', 'b.png'),
      ]);
    });

    it('carries the previews from the pending bubble onto the real message, then lets them go', async () => {
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' });
      const file = { id: 'l1', name: 'a.png', path: '/tmp/a.png', size: 1, category: 'image', mimeType: 'image/png',
        url: 'cindy-media://blobs/l1.png', type: 'image' } as unknown as AttachedFile;
      enqueueBotGroupSend(draft({ text: '' }, { files: [file] }));
      await flush();
      const shownLocal = getBotGroupOutbox('g1')[0]!.attachments;

      const loading = [msg({ id: 'm1', sequence: 1, attachments: [placeholder('s1', 'a.png')] })];
      expect(project('g1', loading)).toEqual({ pending: [], localAttachments: new Map([['m1', shownLocal]]), replacements: new Map([['m1', 'c1']]) });
      noteBotGroupTimeline('g1', loading, beginBotGroupTimelineRead());
      // The entry is settled, the preview stays with the message.
      expect(getBotGroupOutbox('g1')).toEqual([]);
      expect(project('g1', loading).localAttachments.get('m1')).toEqual(shownLocal);

      noteBotGroupTimeline('g1', [msg({ id: 'm1', sequence: 1, attachments: [usable('s1', 'a.png')] })], beginBotGroupTimelineRead());
      expect(getBotGroupOutboxPreviews('g1').size).toBe(0);
    });

    it('drops the previews of a message deleted before its server copies were usable', async () => {
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' });
      const file = { id: 'l1', name: 'a.png', path: '/tmp/a.png', size: 1, category: 'image', mimeType: 'image/png',
        url: 'cindy-media://blobs/l1.png', type: 'image' } as unknown as AttachedFile;
      enqueueBotGroupSend(draft({ text: '' }, { files: [file] }));
      await flush();
      noteBotGroupTimeline('g1', [msg({ id: 'm1', sequence: 1, attachments: [placeholder('s1', 'a.png')] })], beginBotGroupTimelineRead());
      expect(getBotGroupOutboxPreviews('g1').size).toBe(1);

      // Deleted on another device: the tombstone has no attachments, and the preview goes with it.
      noteBotGroupTimeline('g1', [msg({ id: 'm1', sequence: 1, deleted: true, attachments: [] })], beginBotGroupTimelineRead());
      expect(getBotGroupOutboxPreviews('g1').size).toBe(0);
    });

    it('keeps a later message below the copy a re-read shows of an earlier one', async () => {
      const pending = deferred();
      mocks.send.mockReturnValueOnce(pending.promise);
      noteBotGroupTimeline('g1', [], beginBotGroupTimelineRead());
      enqueueBotGroupSend(draft({ text: '先发的', clientId: 'a' }));
      enqueueBotGroupSend(draft({ text: '后发的', clientId: 'b' }));
      await flush();
      // Both were sent on the same timeline; the copy of the first lands before its receipt.
      const projected = project('g1', [msg({ id: 'm1', sequence: 1, content: '先发的' })]);
      expect(projected.pending.map((entry) => [entry.input.clientId, entry.after])).toEqual([['b', 1]]);
    });

    it('lays the previews over the copy a re-read shows before the receipt', async () => {
      const pending = deferred();
      mocks.send.mockReturnValueOnce(pending.promise);
      noteBotGroupTimeline('g1', [], beginBotGroupTimelineRead());
      const file = { id: 'l1', name: 'a.png', path: '/tmp/a.png', size: 1, category: 'image', mimeType: 'image/png',
        url: 'cindy-media://blobs/l1.png', type: 'image' } as unknown as AttachedFile;
      enqueueBotGroupSend(draft({ text: '看图' }, { files: [file] }));
      await flush();
      const copy = msg({ id: 'm1', sequence: 1, content: '看图', attachments: [placeholder('s1', 'a.png')] });
      const projected = project('g1', [copy]);
      expect(projected.pending).toEqual([]);
      expect(projected.localAttachments.get('m1')).toEqual(getBotGroupOutbox('g1')[0]!.attachments);
    });

    it('never swaps two files with the same name, whether the server lists all of them or not yet', () => {
      // Two different photo.png; the first was drawn on, so its burned-in copy is renamed.
      const mine = [local('l1', 'photo-annotated.png'), local('l2', 'photo.png')];
      expect(mergeBotGroupLocalAttachments(
        [placeholder('s1', 'photo-annotated.png'), usable('s2', 'photo.png')], mine,
      )).toEqual([{ ...mine[0], id: 's1' }, usable('s2', 'photo.png')]);
      // Copies listed one by one as they download.
      expect(mergeBotGroupLocalAttachments([usable('s2', 'photo.png')], mine)).toEqual([mine[0], usable('s2', 'photo.png')]);
      expect(mergeBotGroupLocalAttachments([usable('s1', 'photo-annotated.png')], mine)).toEqual([
        usable('s1', 'photo-annotated.png'), mine[1],
      ]);
    });

    it('keeps the local previews of files that share a name until every copy is listed', () => {
      // Two different photo.png and a.png; downloads finish in any order.
      const mine = [local('l1', 'photo.png'), local('l2', 'photo.png'), local('l3', 'a.png')];
      // Only the second photo.png is in: which one it is cannot be told, so neither is replaced.
      expect(mergeBotGroupLocalAttachments([usable('s2', 'photo.png')], mine)).toEqual(mine);
      // A unique name still pairs on its own.
      expect(mergeBotGroupLocalAttachments([usable('s2', 'photo.png'), usable('s3', 'a.png')], mine)).toEqual([
        mine[0], mine[1], usable('s3', 'a.png'),
      ]);
      // Every copy listed: the send order decides.
      expect(mergeBotGroupLocalAttachments([usable('s1', 'photo.png'), usable('s2', 'photo.png'), usable('s3', 'a.png')], mine)).toEqual([
        usable('s1', 'photo.png'), usable('s2', 'photo.png'), usable('s3', 'a.png'),
      ]);
    });
  });

  describe('drawn annotations', () => {
    const original = {
      id: 'l1', name: 'photo.png', path: '/tmp/photo.png', size: 1, category: 'image', mimeType: 'image/png', type: 'image',
      url: 'cindy-media://blobs/original.png', annotationStrokes: [{ points: [{ x: 1, y: 1 }] }],
    } as unknown as AttachedFile;
    const burned = {
      ...original, name: 'photo-annotated.png', url: 'cindy-media://blobs/burned.png', annotated: true,
      annotationSourceUrl: 'cindy-media://blobs/original.png',
    } as unknown as AttachedFile;

    it('shows the burned-in copy as soon as it is ready and burns once for every (re)try', async () => {
      let finishBurn!: (files: AttachedFile[]) => void;
      mocks.materialize.mockImplementationOnce(() => new Promise((resolve) => { finishBurn = resolve; }));
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' })
        .mockResolvedValueOnce({ ok: true, messageId: 'm1' });
      enqueueBotGroupSend(draft({ text: '圈出来的地方' }, { files: [original] }));
      await flush();
      expect(mocks.send).not.toHaveBeenCalled();
      finishBurn([burned]);
      await flush();
      expect(getBotGroupOutbox('g1')[0]!.attachments).toEqual([
        expect.objectContaining({ name: 'photo-annotated.png', url: 'cindy-media://blobs/burned.png' }),
      ]);
      retryBotGroupSend('g1', 'c1');
      await flush();
      expect(mocks.materialize).toHaveBeenCalledTimes(1);
      expect(mocks.send.mock.calls.map(([input]) => input.attachments?.[0]?.url)).toEqual([
        'cindy-media://blobs/burned.png', 'cindy-media://blobs/burned.png',
      ]);
    });

    it('hands the original with its strokes back to the composer, not the burned copy', async () => {
      const restore = vi.fn(() => true);
      registerBotGroupComposer('g1', { restore, notifyFailed: vi.fn() });
      mocks.materialize.mockResolvedValueOnce([burned]);
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      enqueueBotGroupSend(draft({}, { files: [original] }));
      await flush();
      expect(restore).toHaveBeenCalledWith(expect.objectContaining({ files: [original] }));
    });

    it('never sends a queued message whose early burn failed until 重试', async () => {
      const slow = deferred();
      mocks.send.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ ok: true, messageId: 'm2' });
      // The early burn fails; a second burn would succeed.
      mocks.materialize.mockRejectedValueOnce(new Error('burn')).mockResolvedValue([burned]);
      enqueueBotGroupSend(draft({ clientId: 'first' }));
      enqueueBotGroupSend(draft({ clientId: 'drawn' }, { files: [original] }));
      await flush();
      slow.resolve({ ok: true, messageId: 'm1' });
      await flush();
      // Its turn came: the failure is the message's, not a cue to burn again on its own.
      expect(getBotGroupOutbox('g1').find((entry) => entry.input.clientId === 'drawn')?.status).toBe('failed');
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.materialize).toHaveBeenCalledTimes(1);
      retryBotGroupSend('g1', 'drawn');
      await flush();
      expect(mocks.materialize).toHaveBeenCalledTimes(2);
      expect(mocks.send.mock.calls[1]![0].attachments?.[0]?.url).toBe('cindy-media://blobs/burned.png');
    });

    it('tries the burn again on 重试 after it failed', async () => {
      mocks.materialize.mockRejectedValueOnce(new Error('burn')).mockResolvedValueOnce([burned]);
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' });
      enqueueBotGroupSend(draft({}, { files: [original] }));
      await flush();
      expect(getBotGroupOutbox('g1')[0]!.status).toBe('failed');
      expect(mocks.send).not.toHaveBeenCalled();
      retryBotGroupSend('g1', 'c1');
      await flush();
      expect(mocks.materialize).toHaveBeenCalledTimes(2);
      expect(mocks.send.mock.calls[0]![0].attachments?.[0]?.url).toBe('cindy-media://blobs/burned.png');
    });
  });

  describe('holding files outside the draft', () => {
    const file = {
      id: 'f1', name: 'shot.png', path: '/staged/shot.bin', size: 1, category: 'image', mimeType: 'image/png', type: 'image',
      url: 'cindy-media://blobs/shot.png',
    } as unknown as AttachedFile;

    it('protects the media of messages still held from storage cleanup until they are settled', async () => {
      const pending = deferred();
      mocks.send.mockReturnValueOnce(pending.promise);
      enqueueBotGroupSend(draft({ text: '' }, { files: [file] }));
      await flush();
      expect(mocks.protectedUrls).toEqual(['cindy-media://blobs/shot.png']);
      pending.resolve({ ok: true, messageId: 'm1' });
      await flush();
      expect(mocks.protectedUrls).toEqual(['cindy-media://blobs/shot.png']);
      noteBotGroupTimeline('g1', [msg({ id: 'm1', sequence: 1, attachments: [
        { id: 's1', name: 'shot.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/server.png', path: null },
      ] })], beginBotGroupTimelineRead());
      expect(mocks.protectedUrls).toEqual([]);
    });

    it('cleans up staged copies of unsent messages when the group is deleted, never of sent ones', async () => {
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' })
        .mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      const sentFile = { ...file, id: 'f0', path: '/staged/sent.bin' } as AttachedFile;
      enqueueBotGroupSend(draft({ clientId: 'sent' }, { files: [sentFile] }));
      enqueueBotGroupSend(draft({ clientId: 'unsent' }, { files: [file] }));
      await flush();
      discardBotGroupOutbox('g1');
      expect(mocks.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.cleanupStaged).toHaveBeenCalledWith([file]);
      expect(mocks.protectedUrls).toEqual([]);
    });
  });

  describe('a failure while the composer was away', () => {
    it('comes back into an empty composer when it registers, with the reason', async () => {
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'MENTION_UNAVAILABLE', message: '' });
      enqueueBotGroupSend(draft());
      await flush();
      expect(getBotGroupOutbox('g1').map((entry) => entry.status)).toEqual(['failed']);
      const busy = { restore: vi.fn(() => false), notifyFailed: vi.fn() };
      const release = registerBotGroupComposer('g1', busy);
      expect(busy.notifyFailed).not.toHaveBeenCalled();
      expect(getBotGroupOutbox('g1')).toHaveLength(1);
      release();
      const empty = { restore: vi.fn(() => true), notifyFailed: vi.fn() };
      registerBotGroupComposer('g1', empty);
      expect(empty.restore).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ clientId: 'c1' }) }));
      expect(empty.notifyFailed).toHaveBeenCalledWith('bots.groupChat.errors.mentionUnavailable');
      expect(getBotGroupOutbox('g1')).toEqual([]);
    });
  });

  describe('staged files of messages that never went out', () => {
    const staged = (id: string) =>
      ({ id, name: `${id}.txt`, path: `/staged/${id}.bin`, size: 1, category: 'text', mimeType: 'text/plain', type: 'file' }) as unknown as AttachedFile;
    const released = () => mocks.cleanupStaged.mock.calls.map(([files]) => (files as AttachedFile[]).map((file) => file.id).join(','));

    it('on an account switch: releases queued and failed sends, settles the one in flight by its answer', async () => {
      const inFlight = deferred();
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm-sent' })
        .mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' })
        .mockReturnValueOnce(inFlight.promise);
      enqueueBotGroupSend(draft({ clientId: 'sent' }, { files: [staged('sent')] }));
      enqueueBotGroupSend(draft({ clientId: 'failed' }, { files: [staged('failed')] }));
      enqueueBotGroupSend(draft({ clientId: 'flying' }, { files: [staged('flying')] }));
      enqueueBotGroupSend(draft({ clientId: 'queued' }, { files: [staged('queued')] }));
      await flush();
      expect(mocks.send).toHaveBeenCalledTimes(3);

      mocks.owner = 2;
      expect(getBotGroupOutbox('g1')).toEqual([]);
      // Not yet submitted: the outbox owns them and releases them now. The one in flight is main's.
      expect(released().sort()).toEqual(['failed', 'queued']);
      // The in-flight send went out after all: its file stays with the message.
      inFlight.resolve({ ok: true, messageId: 'm-late' });
      await flush();
      // Nothing is sent under the new account, and nothing more is released.
      expect(mocks.send).toHaveBeenCalledTimes(3);
      expect(released().sort()).toEqual(['failed', 'queued']);
    });

    it('on an account switch: releases an in-flight send that did not go out, and one still burning in', async () => {
      const inFlight = deferred();
      let finishBurn!: (files: AttachedFile[]) => void;
      mocks.send.mockReturnValueOnce(inFlight.promise);
      enqueueBotGroupSend(draft({ groupId: 'g1', clientId: 'flying' }, { files: [staged('flying')] }));
      const drawn = { ...staged('drawn'), category: 'image', annotationStrokes: [{ points: [{ x: 1, y: 1 }] }] } as unknown as AttachedFile;
      mocks.materialize.mockImplementationOnce(() => new Promise((resolve) => { finishBurn = resolve; }));
      enqueueBotGroupSend(draft({ groupId: 'g2', clientId: 'burning' }, { files: [drawn] }));
      await flush();
      mocks.owner = 2;
      getBotGroupOutbox('g1');
      inFlight.resolve({ ok: false, errorCode: 'INTERNAL', message: '' });
      finishBurn([drawn]);
      await flush();
      expect(released().sort()).toEqual(['drawn', 'flying']);
      // The burn finished under the new account: the old message is never sent.
      expect(mocks.send).toHaveBeenCalledTimes(1);
    });

    it('on an account switch with no group open: a queued send settles the outbox when its turn comes', async () => {
      const inFlight = deferred();
      mocks.send.mockReturnValueOnce(inFlight.promise);
      const shot = { ...staged('queued'), category: 'image', url: 'cindy-media://blobs/queued.png' } as unknown as AttachedFile;
      enqueueBotGroupSend(draft({ clientId: 'flying' }));
      enqueueBotGroupSend(draft({ clientId: 'queued' }, { files: [shot] }));
      await flush();
      expect(mocks.protectedUrls).toEqual(['cindy-media://blobs/queued.png']);
      // Nothing calls into the outbox after the switch: the queue itself notices it.
      mocks.owner = 2;
      inFlight.resolve({ ok: true, messageId: 'm-late' });
      await flush();
      expect(mocks.protectedUrls).toEqual([]);
      expect(released()).toEqual(['queued']);
      expect(mocks.send).toHaveBeenCalledTimes(1);
    });

    const goneGroup = () => {
      mocks.getBotGroup.mockImplementation(async (groupId: string) =>
        groupId === 'gone' ? { ok: false, errorCode: 'NOT_FOUND', message: '' } : { ok: true, group: {} });
      listGroups(['unrelated']);
    };

    it('discards a group that left the list once a read confirms it is gone; unsubmitted files go at once', async () => {
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      enqueueBotGroupSend(draft({ groupId: 'gone', clientId: 'failed' }, { files: [staged('failed')] }));
      enqueueBotGroupSend(draft({ groupId: 'kept', clientId: 'other' }, { files: [staged('other')] }));
      await flush();
      mocks.send.mockReturnValue(new Promise(() => undefined));
      // `kept` is missing from the list too (e.g. a legacy id), but still reads fine: untouched.
      goneGroup();
      await flush();
      expect(mocks.getBotGroup.mock.calls.map(([groupId]) => groupId).sort()).toEqual(['gone', 'kept']);
      expect(getBotGroupOutbox('gone')).toEqual([]);
      expect(getBotGroupOutbox('kept')).toHaveLength(1);
      expect(released()).toEqual(['failed']);
    });

    it.each([
      ['went out', { ok: true, messageId: 'm1' }, []],
      ['was refused', { ok: false, errorCode: 'INTERNAL', message: '' }, ['flying']],
    ] as const)('A) a send already with main when its group is discarded: files stay until main answers, then kept if it %s', async (_label, answer, expected) => {
      const late = deferred();
      mocks.send.mockReturnValueOnce(late.promise);
      enqueueBotGroupSend(draft({ groupId: 'gone', clientId: 'flying' }, { files: [staged('flying')] }));
      await flush();
      expect(mocks.send).toHaveBeenCalledTimes(1);
      goneGroup();
      await flush();
      expect(getBotGroupOutbox('gone')).toEqual([]);
      // Main may still be reading the file and deciding: nothing is cleaned up before it answers.
      expect(mocks.cleanupStaged).not.toHaveBeenCalled();
      late.resolve(answer);
      await flush();
      expect(released()).toEqual(expected);
      expect(getBotGroupOutbox('gone')).toEqual([]);
    });

    it('A) a lost answer (the call itself rejects) after its group is discarded releases the files once', async () => {
      const late = deferred();
      mocks.send.mockReturnValueOnce(late.promise);
      enqueueBotGroupSend(draft({ groupId: 'gone', clientId: 'flying' }, { files: [staged('flying')] }));
      await flush();
      goneGroup();
      await flush();
      expect(mocks.cleanupStaged).not.toHaveBeenCalled();
      late.reject(new Error('ipc closed'));
      await flush();
      expect(released()).toEqual(['flying']);
    });

    it('B) a message still burning in when its group is discarded is never sent, and its files go once', async () => {
      let finishBurn!: (files: AttachedFile[]) => void;
      const drawn = { ...staged('drawn'), category: 'image', annotationStrokes: [{ points: [{ x: 1, y: 1 }] }] } as unknown as AttachedFile;
      mocks.materialize.mockImplementationOnce(() => new Promise((resolve) => { finishBurn = resolve; }));
      enqueueBotGroupSend(draft({ groupId: 'gone', clientId: 'burning' }, { files: [drawn] }));
      await flush();
      goneGroup();
      await flush();
      expect(getBotGroupOutbox('gone')).toEqual([]);
      // Submission has started (it owns the files): not released yet, not sent yet.
      expect(mocks.cleanupStaged).not.toHaveBeenCalled();
      finishBurn([{ ...drawn, annotated: true } as AttachedFile]);
      await flush();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(released()).toEqual(['drawn']);
    });

    describe('a read that is not definite', () => {
      const failOne = async () => {
        mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
        enqueueBotGroupSend(draft({ groupId: 'g1', clientId: 'failed' }, { files: [staged('failed')] }));
        await flush();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      };
      afterEach(() => vi.useRealTimers());

      it('is retried on its own and discards once a later read says NOT_FOUND', async () => {
        await failOne();
        mocks.getBotGroup.mockRejectedValueOnce(new Error('ipc'))
          .mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' })
          .mockResolvedValueOnce({ ok: false, errorCode: 'NOT_FOUND', message: '' });
        listGroups([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(BOT_GROUP_GONE_RETRY_MS[0]);
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(2);
        expect(getBotGroupOutbox('g1')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(BOT_GROUP_GONE_RETRY_MS[1]);
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(3);
        expect(getBotGroupOutbox('g1')).toEqual([]);
        expect(released()).toEqual(['failed']);
      });

      it('gives up after the last retry, keeping the outbox', async () => {
        await failOne();
        mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'INTERNAL', message: '' });
        listGroups([]);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(1 + BOT_GROUP_GONE_RETRY_MS.length);
        expect(getBotGroupOutbox('g1')).toHaveLength(1);
        expect(mocks.cleanupStaged).not.toHaveBeenCalled();
      });

      it('stops once the group is listed again or reads fine', async () => {
        await failOne();
        mocks.getBotGroup.mockRejectedValueOnce(new Error('ipc'));
        listGroups([]);
        await vi.advanceTimersByTimeAsync(0);
        mocks.list = { groups: [{ id: 'g1' }], loaded: true };
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
        expect(getBotGroupOutbox('g1')).toHaveLength(1);
      });
    });

    it('keeps a group that is only missing from the list when the read fails or is not definite', async () => {
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      enqueueBotGroupSend(draft({ groupId: 'g1', clientId: 'failed' }, { files: [staged('failed')] }));
      await flush();
      mocks.getBotGroup.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      listGroups([]);
      await flush();
      mocks.getBotGroup.mockRejectedValueOnce(new Error('offline'));
      listGroups([]);
      await flush();
      expect(getBotGroupOutbox('g1')).toHaveLength(1);
      expect(mocks.cleanupStaged).not.toHaveBeenCalled();
      // Listed groups are never re-read.
      mocks.getBotGroup.mockClear();
      listGroups(['g1']);
      await flush();
      expect(mocks.getBotGroup).not.toHaveBeenCalled();
    });
  });

  describe('the same account', () => {
    const staged = (id: string) =>
      ({ id, name: `${id}.txt`, path: `/staged/${id}.bin`, size: 1, category: 'text', mimeType: 'text/plain', type: 'file' }) as unknown as AttachedFile;

    it('keeps queued, failed and in-flight messages through a same-owner generation repair and a passing null', async () => {
      const inFlight = deferred();
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' }).mockReturnValueOnce(inFlight.promise);
      enqueueBotGroupSend(draft({ clientId: 'failed' }, { files: [staged('failed')] }));
      enqueueBotGroupSend(draft({ clientId: 'flying' }, { files: [staged('flying')] }));
      enqueueBotGroupSend(draft({ clientId: 'queued' }, { files: [staged('queued')] }));
      await flush();
      // A repair keeps the account and moves the generation; an auth boundary publishes null for a moment.
      mocks.generation += 1;
      expect(getBotGroupOutbox('g1').map((entry) => entry.input.clientId)).toEqual(['failed', 'flying', 'queued']);
      mocks.owner = null;
      expect(getBotGroupOutbox('g1')).toHaveLength(3);
      inFlight.resolve({ ok: true, messageId: 'm-flying' });
      mocks.owner = 1;
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm-queued' });
      await flush();
      expect(getBotGroupOutbox('g1').map((entry) => `${entry.input.clientId}:${entry.status}`)).toEqual([
        'failed:failed', 'flying:sent', 'queued:sent',
      ]);
      expect(mocks.cleanupStaged).not.toHaveBeenCalled();
    });

    it('still clears for a different account, even after a null in between', async () => {
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      enqueueBotGroupSend(draft({ clientId: 'failed' }, { files: [staged('failed')] }));
      await flush();
      mocks.owner = null;
      expect(getBotGroupOutbox('g1')).toHaveLength(1);
      mocks.owner = 2;
      expect(getBotGroupOutbox('g1')).toEqual([]);
      expect(mocks.cleanupStaged).toHaveBeenCalledWith([staged('failed')]);
    });
  });

  describe('previews of confirmed messages', () => {
    const image = (id: string) =>
      ({ id, name: `${id}.png`, path: `/tmp/${id}.png`, size: 1, category: 'image', mimeType: 'image/png', type: 'image', url: `cindy-media://blobs/${id}.png` }) as unknown as AttachedFile;
    const loading = (messageId: string, name: string) => msg({ id: messageId, sequence: 1, attachments: [
      { id: `media-${messageId}`, name, category: 'image', mimeType: 'image/png', size: 1, url: null, path: null },
    ] });

    it('are not listed for storage cleanup protection: main pinned them when the message was sent', async () => {
      mocks.send.mockResolvedValueOnce({ ok: true, messageId: 'm1' });
      enqueueBotGroupSend(draft({ text: '' }, { files: [image('a')] }));
      await flush();
      noteBotGroupTimeline('g1', [loading('m1', 'a.png')], beginBotGroupTimelineRead());
      expect(getBotGroupOutboxPreviews('g1').size).toBe(1);
      expect(mocks.protectedUrls).toEqual([]);
    });

    it('are never evicted while their server copies are not usable, however many there are', async () => {
      const count = 40;
      for (let i = 0; i < count; i += 1) mocks.send.mockResolvedValueOnce({ ok: true, messageId: `m${i}` });
      for (let i = 0; i < count; i += 1) enqueueBotGroupSend(draft({ clientId: `c${i}`, text: '' }, { files: [image(`p${i}`)] }));
      await flush();
      noteBotGroupTimeline('g1', Array.from({ length: count }, (_, i) => ({ ...loading(`m${i}`, `p${i}.png`), sequence: i + 1 })), beginBotGroupTimelineRead());
      expect(getBotGroupOutboxPreviews('g1').size).toBe(count);
      expect(getBotGroupOutbox('g1')).toEqual([]);
    });

    it('a gone-check read that spans an owner change is no answer; a later read under a stable owner decides', async () => {
      mocks.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: '' });
      enqueueBotGroupSend(draft({ clientId: 'failed' }, { files: [image('kept')] }));
      await flush();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let answer!: (value: unknown) => void;
        mocks.getBotGroup.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
          .mockResolvedValueOnce({ ok: false, errorCode: 'NOT_FOUND', message: '' });
        listGroups([]);
        await vi.advanceTimersByTimeAsync(0);
        // Same account, repaired generation while the read was out.
        mocks.generation += 1;
        answer({ ok: false, errorCode: 'NOT_FOUND', message: '' });
        await vi.advanceTimersByTimeAsync(0);
        expect(getBotGroupOutbox('g1')).toHaveLength(1);
        expect(mocks.cleanupStaged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(BOT_GROUP_GONE_RETRY_MS[0]);
        expect(getBotGroupOutbox('g1')).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// Unit regression: a restart between local enqueue and the HTTP response used to lose
// ownership. The production outbox must save first, then restore the same clientId FIFO.
it.each(['group', 'direct'] as const)('durably restores %s sends and reconciles both receipt pages without deleting pending entries', async kind => {
  vi.useFakeTimers();
  const saved = new Map<string, unknown>();
  mocks.storage = async request => {
    if (request.action === 'put') saved.set(request.entry.input.clientId, structuredClone(request.entry));
    if (request.action === 'remove') saved.delete(request.clientId);
    return request.action === 'list' ? [...saved.values()] : [];
  };
  mocks.send.mockRejectedValueOnce(new Error('offline'));
  const conversation = kind === 'direct' ? { conversationKind: 'direct' as const } : {};
  await enqueueBotGroupSend(draft({ clientId: 'first', ...conversation }));
  await enqueueBotGroupSend(draft({ clientId: 'second', ...conversation }));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(saved.size).toBe(2);
  resetBotGroupOutboxForTests();
  mocks.send.mockImplementation(async input => ({ ok: true, messageId: `server-${input.clientId}` }));
  mocks.getBotGroup.mockImplementation(async (_id, options) => kind === 'direct' && options?.conversationKind !== 'direct'
    ? { ok: false, errorCode: 'NOT_FOUND' } : { ok: true, group: { messages: [] } });
  const events = new EventTarget();
  vi.stubGlobal('window', events);
  const stop = startBotGroupOutbox();
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.send.mock.calls.map(([input]) => input.clientId)).toEqual(['first', 'first', 'second']);
    expect(getBotGroupOutbox('g1').map(row => row.status)).toEqual(['sent', 'sent']);
    // Direct chats need not appear in the group list. Its absence must use the
    // same direct read contract rather than erase valid receipts as NOT_FOUND.
    listGroups([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupOutbox('g1')).toHaveLength(2);
    noteBotGroupTimeline('g1', [msg({ id: 'unrelated', sequence: 20 })], beginBotGroupTimelineRead());
    expect(saved.size).toBe(2);
    mocks.getBotGroup.mockImplementation(async (_id, options) => kind === 'direct' && options?.conversationKind !== 'direct'
      ? { ok: false, errorCode: 'NOT_FOUND' } : ({ ok: true, group: options?.beforeSequence
      ? { messages: [msg({ id: 'server-first', sequence: 1 }), msg({ id: 'server-second', sequence: 2 })], hasMoreBefore: false }
      : { messages: [msg({ id: 'newer', sequence: 20 })], hasMoreBefore: true } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.getBotGroup).toHaveBeenCalledWith('g1', { beforeSequence: 20, ...conversation });
    expect(saved.size).toBe(0);
  } finally { stop(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
