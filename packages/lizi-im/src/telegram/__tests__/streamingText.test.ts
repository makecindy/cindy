import { describe, expect, it, vi } from 'vitest';

import { startTelegramStreaming, type TelegramStreamingDeps } from '../streamingText.js';

/**
 * 终稿原位编辑撞 Telegram 编辑 flood 时的兜底(2026-08-04 线上实测: 一个 11 分钟
 * 群轮次的 finalize 吃到 `429 retry after 26`, 整条答案永久丢失, 聊天里只剩一条
 * 停在"⚙️ 工作中"的僵尸消息)。这些用例钉住三件事: 答案必达、顺序是先发新后删旧、
 * 补送后的图片锚点跟到新消息。
 */

interface Harness {
  deps: TelegramStreamingDeps;
  /** 按发生顺序记录的出站动作, 用于断言"先发新、后删旧"。 */
  calls: string[];
  sent: string[];
  reposted: string[];
  deleted: string[];
  uploadAnchors: string[];
}

function makeHarness(
  overrides: {
    editImpl?: (messageId: string, markdown: string) => Promise<void>;
    sendImpl?: (markdown: string) => Promise<string>;
    deleteImpl?: (messageId: string) => Promise<void>;
    chunk?: (text: string) => string[];
    extractImageUrls?: (markdown: string) => string[];
    /** 不提供 repost 时用于验证回落 send 的行为。 */
    withoutRepost?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const sent: string[] = [];
  const reposted: string[] = [];
  const deleted: string[] = [];
  const uploadAnchors: string[] = [];
  let nextId = 1;
  const deps: TelegramStreamingDeps = {
    send: async (markdown) => {
      calls.push(`send:${markdown}`);
      sent.push(markdown);
      if (overrides.sendImpl) return overrides.sendImpl(markdown);
      return `msg-${nextId++}`;
    },
    edit: async (messageId, markdown) => {
      calls.push(`edit:${messageId}`);
      if (overrides.editImpl) return overrides.editImpl(messageId, markdown);
    },
    uploadImages: async (messageId, imageUrls) => {
      if (imageUrls.length > 0) {
        calls.push(`upload:${messageId}`);
        uploadAnchors.push(messageId);
      }
    },
    chunk: overrides.chunk ?? ((text) => [text]),
    extractImageUrls: overrides.extractImageUrls ?? (() => []),
    deleteMessage: async (messageId) => {
      calls.push(`delete:${messageId}`);
      deleted.push(messageId);
      if (overrides.deleteImpl) return overrides.deleteImpl(messageId);
    },
  };
  if (overrides.withoutRepost !== true) {
    deps.repost = async (markdown) => {
      calls.push(`repost:${markdown}`);
      reposted.push(markdown);
      if (overrides.sendImpl) return overrides.sendImpl(markdown);
      return `msg-${nextId++}`;
    };
  }
  return { deps, calls, sent, reposted, deleted, uploadAnchors };
}

describe('telegram streaming finalize — 原位定稿与 flood 兜底', () => {
  it('原位编辑成功时不新发、不删旧消息', async () => {
    const h = makeHarness();
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 3s');
    await handle.finalize('最终答案');

    expect(h.calls).toEqual(['send:⚙️ 工作中 · 3s', 'edit:msg-1']);
    expect(h.deleted).toEqual([]);
  });

  it('原位编辑失败 → 答案改由新消息承载, 且顺序是先发新后删旧', async () => {
    const editErr = new Error('telegram editMessageText failed: 429 Too Many Requests: retry after 26');
    const h = makeHarness({
      editImpl: async () => {
        throw editErr;
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 10m44s');

    await expect(handle.finalize('完整的最终答案')).resolves.toBeUndefined();

    // 答案确实发出去了(不是只剩一条僵尸过程消息), 且走的是保留回挂目标的 repost。
    expect(h.reposted).toEqual(['完整的最终答案']);
    expect(h.sent).not.toContain('完整的最终答案');
    // 顺序不可对调: 新消息落地在删除之前。
    expect(h.calls).toEqual([
      'send:⚙️ 工作中 · 10m44s',
      'edit:msg-1',
      'repost:完整的最终答案',
      'delete:msg-1',
    ]);
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('未提供 repost 时回落 send(兼容不关心回挂语义的调用方)', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('429');
      },
      withoutRepost: true,
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 6s');

    await expect(handle.finalize('答案')).resolves.toBeUndefined();
    expect(h.sent).toContain('答案');
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('新发也失败时抛回原始编辑错误, 并且不删旧消息', async () => {
    const editErr = new Error('editMessageText failed: 429');
    let sendCount = 0;
    const h = makeHarness({
      editImpl: async () => {
        throw editErr;
      },
      sendImpl: async () => {
        sendCount += 1;
        // 第一次是建流式占位, 第二次才是补送。
        if (sendCount > 1) throw new Error('sendMessage failed: 429');
        return 'msg-1';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 9m');

    // 掩盖真实原因会让线上排障失去线索 —— 必须抛原始编辑错误。
    await expect(handle.finalize('答案')).rejects.toBe(editErr);
    expect(h.deleted).toEqual([]);
  });

  it('旧消息删不掉不影响已送达的答案', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('429');
      },
      deleteImpl: async () => {
        throw new Error("message can't be deleted");
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 2m');

    await expect(handle.finalize('答案')).resolves.toBeUndefined();
    expect(h.reposted).toContain('答案');
  });

  it('补送后受管图片锚定到新消息, 不挂在已删的过程消息上', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('429');
      },
      extractImageUrls: () => ['cindy-media://blobs/a.png'],
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 1m');

    await handle.finalize('带图的答案');

    // 锚点是补送出来的那条(msg-2), 不是被删掉的 msg-1。
    expect(h.uploadAnchors).toEqual(['msg-2']);
  });

  it('补送后剩余分段照常发出', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('429');
      },
      chunk: (text) => text.split('|'),
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 5m');

    await handle.finalize('第一段|第二段|第三段');

    // 首段走 repost(承载答案、保留回挂), 其余分段照常 send 追加。
    expect(h.reposted).toEqual(['第一段']);
    expect(h.sent).toEqual(['⚙️ 工作中 · 5m', '第二段', '第三段']);
  });

  it('rich 原位定稿成功时既不走 HTML 编辑也不补送', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('不该走到这里');
      },
    });
    const editFinal = vi.fn(async () => true);
    const handle = await startTelegramStreaming({ ...h.deps, editFinal }, '⚙️ 工作中 · 4s');

    await handle.finalize('rich 定稿的答案');

    expect(editFinal).toHaveBeenCalledOnce();
    expect(h.sent).toEqual(['⚙️ 工作中 · 4s']);
    expect(h.deleted).toEqual([]);
  });

  it('NO_REPLY 沉默仍然是撤掉占位, 不会误走补送', async () => {
    const h = makeHarness();
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 8s');

    await handle.finalize('NO_REPLY');

    expect(h.deleted).toEqual(['msg-1']);
    expect(h.sent).toEqual(['⚙️ 工作中 · 8s']);
  });

  // #1855 L1: NO_REPLY 生效范围 = all-turns。streamingText 层不认识 ambient/非 ambient,
  // finalize 的 isNoReply 判定对任何轮次一视同仁 —— 惰性占位下(未建过消息)整条
  // NO_REPLY 从头到尾零出站零删除, 与 TELEGRAM_PERSONAL_CAPABILITIES.noReplyScope 一致。
  it('NO_REPLY(惰性占位, 未建消息)零出站零删除 — 任何轮次一视同仁(all-turns)', async () => {
    const h = makeHarness();
    const handle = await startTelegramStreaming(h.deps); // 无初始占位

    await handle.finalize('NO_REPLY');

    expect(h.sent).toEqual([]);
    expect(h.reposted).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(handle.messageId).toBe('');
  });
});
