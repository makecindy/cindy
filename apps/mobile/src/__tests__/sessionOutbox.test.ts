import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildOutboxItem,
  createOutboxClientId,
  outboxDisplayItem,
  outboxItemAttachments,
  outboxItemReady,
  outboxItemRetrying,
  outboxItemWithEnqueueFailure,
  outboxItemWithUpload,
  outboxItemWithUploadFailure,
  outboxOwnsUpload,
  outboxWithUploadResult,
  recoverOutboxItemsToComposerDraft,
  replaceOutboxItem,
} from '@/session/sessionOutbox';
import type { RemoteSerializedAttachment } from '@/session/types';
import { serializeComposerDocument } from '@/session/composerDocument';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function attachmentFor(name: string): RemoteSerializedAttachment {
  return {
    id: `mobile-upload:key/${name}`,
    name,
    path: `cindy-oss-attach://key/${name}`,
    ext: '.jpg',
    size: 500_000,
    category: 'image',
    mimeType: 'image/jpeg',
  };
}

function itemWith(overrides: Partial<Parameters<typeof buildOutboxItem>[0]> = {}) {
  return buildOutboxItem({
    clientId: 'c-1',
    sessionId: 's-1',
    text: 'hello',
    permissionModeAtSend: 'ask',
    readyAttachments: [],
    claimedUploads: [],
    ...overrides,
  });
}

describe('createOutboxClientId', () => {
  it('生成非空且互不相同的 id', () => {
    const a = createOutboxClientId();
    const b = createOutboxClientId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe('buildOutboxItem', () => {
  it('就绪附件占前段槽位,在途任务按序占后段;有失败卡时直接失败态', () => {
    const ready = [attachmentFor('a.jpg')];
    const item = buildOutboxItem({
      clientId: 'c-1',
      sessionId: 's-1',
      text: 'hi',
      permissionModeAtSend: 'plan',
      readyAttachments: ready,
      claimedUploads: [
        { localId: 'u-1', failed: false },
        { localId: 'u-2', failed: true },
      ],
    });
    expect(item.attachmentSlots).toEqual([ready[0], null, null]);
    expect(item.slotByLocalId).toEqual({ 'u-1': 1, 'u-2': 2 });
    expect(item.waitingIds).toEqual(['u-1']);
    expect(item.failedIds).toEqual(['u-2']);
    expect(item.phase).toBe('failed');
    expect(outboxItemReady(item)).toBe(false);
  });

  it('纯文本(无附件)即刻就绪', () => {
    const item = itemWith();
    expect(outboxItemReady(item)).toBe(true);
    expect(outboxItemAttachments(item)).toEqual([]);
  });

  it('keeps quote metadata until the outbox item is dispatched', () => {
    expect(itemWith({ quotesEncoded: true }).quotesEncoded).toBe(true);
    expect(itemWith().quotesEncoded).toBe(false);
  });

  it('keeps session reference source hints until the outbox item is dispatched', () => {
    const sessionRefs = [{ sessionId: 'source', deviceId: 'source-device' }];
    const item = itemWith({ sessionRefs });

    expect(item.sessionRefs).toEqual(sessionRefs);
    expect(item.sessionRefs).not.toBe(sessionRefs);
  });

  it('keeps structured reference metadata until dispatch', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `inspect ${href}`;
    const reference = {
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    };

    expect(itemWith({ text, agentReferences: [reference] }).agentReferences)
      .toEqual([reference]);
  });
});

describe('recoverOutboxItemsToComposerDraft', () => {
  it('restores marked quotes separately while keeping the composer text marker-free', () => {
    const encoded = [
      '> <!-- cindy-composer-quote -->',
      '> selected',
      '',
      'reply',
      '',
      '> <!-- cindy-composer-quote -->',
      '> second',
      '',
      'more',
    ].join('\n');
    const item = itemWith({ text: encoded, quotesEncoded: true });

    const recovery = recoverOutboxItemsToComposerDraft([item], {
      visibleText: 'new draft',
      encodedBody: 'new draft',
      quotes: [],
    });
    expect(recovery).toMatchObject({
      visibleText: 'reply\n\nmore\n\nnew draft',
      encodedBody: `${encoded}\n\nnew draft`,
      quotes: [{ text: 'selected' }, { text: 'second' }],
    });
    expect(serializeComposerDocument(recovery.document).text).toBe(`${encoded}\n\nnew draft`);
  });

  it('keeps existing quoted draft metadata aligned after outbox recovery', () => {
    const recoveredEncoded = [
      '> <!-- cindy-composer-quote -->',
      '> recovered quote',
      '',
      'recovered reply',
    ].join('\n');
    const existingEncoded = [
      '> <!-- cindy-composer-quote -->',
      '> existing quote',
      '',
      'existing reply',
    ].join('\n');

    const recovery = recoverOutboxItemsToComposerDraft(
      [itemWith({ text: recoveredEncoded, quotesEncoded: true })],
      {
        visibleText: 'existing reply',
        encodedBody: existingEncoded,
        quotes: [{ text: 'existing quote' }],
      },
    );
    expect(recovery).toMatchObject({
      visibleText: 'recovered reply\n\nexisting reply',
      encodedBody: `${recoveredEncoded}\n\n${existingEncoded}`,
      quotes: [{ text: 'recovered quote' }, { text: 'existing quote' }],
    });
    expect(serializeComposerDocument(recovery.document).text).toBe(
      `${recoveredEncoded}\n\n${existingEncoded}`,
    );
  });

  it('keeps markerless legacy parsing leading-only during salvage', () => {
    const encoded = '> old quote\n\nHere:\n> user markdown';
    const item = itemWith({ text: encoded, quotesEncoded: true });

    expect(recoverOutboxItemsToComposerDraft([item])).toMatchObject({
      visibleText: 'Here:\n> user markdown',
      encodedBody: encoded,
      quotes: [{ text: 'old quote' }],
    });
  });

  it('restores pasted-text and slash atoms instead of flattening failed attachment sends', () => {
    const item = itemWith({
      text: '/help before long\ntext after',
      pastedTextRanges: [{ start: 13, end: 22, display: 'Pasted text (2 lines)' }],
      slashCommandRanges: [{ start: 0, end: 5 }],
    });
    const recovery = recoverOutboxItemsToComposerDraft([item]);

    expect(recovery.document.nodes.map((node) => node.type)).toEqual([
      'text', 'text', 'pasted-text', 'text',
    ]);
    expect(serializeComposerDocument(recovery.document)).toMatchObject({
      pastedTextRanges: [{ start: 13, end: 22, display: 'Pasted text (2 lines)' }],
      slashCommandRanges: [{ start: 0, end: 5 }],
    });
  });

  it('restores message references instead of flattening them to private URIs', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `inspect ${href}`;
    const reference = {
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    };
    const recovery = recoverOutboxItemsToComposerDraft([
      itemWith({ text, agentReferences: [reference] }),
    ]);

    expect(serializeComposerDocument(recovery.document).agentReferences)
      .toEqual([reference]);
  });
});

describe('outboxItemWithUpload / outboxItemWithUploadFailure', () => {
  it('上传成功按 localId 填槽,全部落定后就绪且附件保持槽序', () => {
    const ready = [attachmentFor('first.jpg')];
    let item = buildOutboxItem({
      clientId: 'c-1',
      sessionId: 's-1',
      text: 'hi',
      permissionModeAtSend: 'ask',
      readyAttachments: ready,
      claimedUploads: [
        { localId: 'u-1', failed: false },
        { localId: 'u-2', failed: false },
      ],
    });
    expect(outboxItemReady(item)).toBe(false);
    // 后入队的先完成:槽序不受完成顺序影响。
    const late = attachmentFor('late.jpg');
    const early = attachmentFor('early.jpg');
    item = outboxItemWithUpload(item, 'u-2', late);
    expect(outboxItemReady(item)).toBe(false);
    item = outboxItemWithUpload(item, 'u-1', early);
    expect(outboxItemReady(item)).toBe(true);
    expect(outboxItemAttachments(item)).toEqual([ready[0], early, late]);
  });

  it('不属于本条目的 localId 返回原引用', () => {
    const item = itemWith({ claimedUploads: [{ localId: 'u-1', failed: false }] });
    expect(outboxItemWithUpload(item, 'other', attachmentFor('x.jpg'))).toBe(item);
    expect(outboxItemWithUploadFailure(item, 'other')).toBe(item);
  });

  it('上传失败转失败态并阻塞就绪;重复失败回调幂等', () => {
    let item = itemWith({ claimedUploads: [{ localId: 'u-1', failed: false }] });
    item = outboxItemWithUploadFailure(item, 'u-1');
    expect(item.phase).toBe('failed');
    expect(item.failedIds).toEqual(['u-1']);
    expect(item.waitingIds).toEqual([]);
    expect(outboxItemWithUploadFailure(item, 'u-1')).toBe(item);
  });

  it('失败任务重试成功(直接收到 onUploaded)时从 failedIds 摘除并解除失败态', () => {
    let item = itemWith({ claimedUploads: [{ localId: 'u-1', failed: true }] });
    expect(item.phase).toBe('failed');
    item = outboxItemWithUpload(item, 'u-1', attachmentFor('a.jpg'));
    expect(item.failedIds).toEqual([]);
    expect(item.phase).toBe('uploading');
    expect(outboxItemReady(item)).toBe(true);
  });
});

describe('outboxItemRetrying / outboxItemWithEnqueueFailure', () => {
  it('重试把失败任务移回等待集并清除 enqueue 错误', () => {
    let item = itemWith({ claimedUploads: [{ localId: 'u-1', failed: true }] });
    item = outboxItemWithEnqueueFailure(item, 'boom');
    expect(item.phase).toBe('failed');
    expect(item.enqueueError).toBe('boom');
    item = outboxItemRetrying(item);
    expect(item.phase).toBe('uploading');
    expect(item.enqueueError).toBeNull();
    expect(item.waitingIds).toEqual(['u-1']);
    expect(item.failedIds).toEqual([]);
  });

  it('enqueue 失败型(附件已齐)重试后即刻就绪,可直接重新派发', () => {
    let item = itemWith();
    item = outboxItemWithEnqueueFailure(item, 'network');
    expect(outboxItemReady(item)).toBe(false);
    item = outboxItemRetrying(item);
    expect(outboxItemReady(item)).toBe(true);
  });
});

describe('outboxDisplayItem', () => {
  it('上传进度与失败文案', () => {
    let item = buildOutboxItem({
      clientId: 'c-1',
      sessionId: 's-1',
      text: 'hi',
      permissionModeAtSend: 'ask',
      readyAttachments: [attachmentFor('a.jpg')],
      claimedUploads: [{ localId: 'u-1', failed: false }],
    });
    expect(outboxDisplayItem(item)).toMatchObject({
      attachmentCount: 2,
      uploadedCount: 1,
      failed: false,
      errorText: null,
    });
    item = outboxItemWithUploadFailure(item, 'u-1');
    const display = outboxDisplayItem(item);
    expect(display.failed).toBe(true);
    expect(display.errorText).toContain('附件上传失败');
    const enqueueFailed = outboxDisplayItem(outboxItemWithEnqueueFailure(itemWith(), 'RPC boom'));
    expect(enqueueFailed.errorText).toBe('RPC boom');
  });

  it('图片槽出缩略格(本地预览 / 落定 ossRef / 上传中态),文件槽走计数行', () => {
    let item = buildOutboxItem({
      clientId: 'c-1',
      sessionId: 's-1',
      text: 'hi',
      permissionModeAtSend: 'ask',
      readyAttachments: [attachmentFor('ready.jpg')],
      readyPreviews: ['file:///tmp/ready-preview.jpg'],
      claimedUploads: [
        { localId: 'u-img', failed: false, kind: 'image', previewUri: 'file:///tmp/pending.jpg' },
        { localId: 'u-pdf', failed: false, kind: 'file', previewUri: 'file:///tmp/scan.pdf' },
      ],
    });
    let display = outboxDisplayItem(item);
    // 就绪图:本地预览 + ossRef 双源;上传中图:仅本地预览,uploading 真;pdf 不进缩略条。
    expect(display.thumbnails).toEqual([
      {
        key: 'c-1-slot-0',
        uri: 'file:///tmp/ready-preview.jpg',
        ossRef: 'cindy-oss-attach://key/ready.jpg',
        uploading: false,
      },
      { key: 'c-1-slot-1', uri: 'file:///tmp/pending.jpg', ossRef: null, uploading: true },
    ]);
    expect(display.fileCount).toBe(1);
    // 上传落定后:uploading 归零,ossRef 补上,本地预览保留(第一帧到落定零跳变)。
    item = outboxItemWithUpload(item, 'u-img', attachmentFor('landed.jpg'));
    display = outboxDisplayItem(item);
    expect(display.thumbnails[1]).toEqual({
      key: 'c-1-slot-1',
      uri: 'file:///tmp/pending.jpg',
      ossRef: 'cindy-oss-attach://key/landed.jpg',
      uploading: false,
    });
  });
});

describe('outboxWithUploadResult / outboxOwnsUpload / replaceOutboxItem', () => {
  it('按 localId 路由到正确条目;不属于任何条目时返回原引用', () => {
    const first = buildOutboxItem({
      clientId: 'c-1',
      sessionId: 's-1',
      text: 'one',
      permissionModeAtSend: 'ask',
      readyAttachments: [],
      claimedUploads: [{ localId: 'u-1', failed: false }],
    });
    const second = buildOutboxItem({
      clientId: 'c-2',
      sessionId: 's-1',
      text: 'two',
      permissionModeAtSend: 'ask',
      readyAttachments: [],
      claimedUploads: [{ localId: 'u-2', failed: false }],
    });
    const items = [first, second];
    expect(outboxOwnsUpload(items, 'u-2')).toBe(true);
    expect(outboxOwnsUpload(items, 'nope')).toBe(false);
    const next = outboxWithUploadResult(items, 'u-2', { attachment: attachmentFor('b.jpg') });
    expect(next).not.toBe(items);
    expect(next[0]).toBe(first);
    expect(outboxItemReady(next[1]!)).toBe(true);
    expect(outboxWithUploadResult(items, 'nope', { failed: true })).toBe(items);
  });

  it('replaceOutboxItem 原位替换,找不到返回原引用', () => {
    const item = itemWith();
    const other = { ...item, clientId: 'other' };
    const items = [item];
    expect(replaceOutboxItem(items, other)).toBe(items);
    const replaced = replaceOutboxItem(items, { ...item, text: 'changed' });
    expect(replaced[0]?.text).toBe('changed');
  });
});
