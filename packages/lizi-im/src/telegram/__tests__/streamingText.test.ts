import { describe, expect, it, vi } from 'vitest';

import { startTelegramStreaming, type TelegramStreamingDeps } from '../streamingText.js';

/**
 * 终稿永远使用新消息(2026-08): 过程载体不再承担答案，避免最后一次编辑撞 flood
 * 或被群 relay 覆盖。用例钉住三件事: 先发新后删旧、Rich 新发保留结构化内容、
 * Rich 不可用时安全回落 HTML。
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
    sendFinalImpl?: (markdown: string, reuseReplyTarget: boolean) => Promise<string | null>;
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
  if (overrides.sendFinalImpl) {
    deps.sendFinal = async (markdown, reuseReplyTarget) => {
      calls.push(`final:${markdown}:${reuseReplyTarget}`);
      return overrides.sendFinalImpl!(markdown, reuseReplyTarget);
    };
  }
  return { deps, calls, sent, reposted, deleted, uploadAnchors };
}

describe('telegram streaming finalize — 新鲜终稿与 Rich 降级', () => {
  it('过程消息存在时终稿始终新发，随后才删除旧消息', async () => {
    const h = makeHarness();
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 3s');
    await handle.finalize('最终答案');

    expect(h.calls).toEqual([
      'send:⚙️ 工作中 · 3s',
      'repost:最终答案',
      'delete:msg-1',
    ]);
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('不再依赖终稿 edit，即使 edit 会失败仍先发答案后删过程消息', async () => {
    const h = makeHarness({
      editImpl: async () => {
        throw new Error('must not edit final');
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
      'repost:完整的最终答案',
      'delete:msg-1',
    ]);
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('未提供 repost 时回落 send(兼容不关心回挂语义的调用方)', async () => {
    const h = makeHarness({
      withoutRepost: true,
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 6s');

    await expect(handle.finalize('答案')).resolves.toBeUndefined();
    expect(h.sent).toContain('答案');
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('新发失败时保留过程消息并抛出发送错误', async () => {
    const sendErr = new Error('sendMessage failed: 429');
    let sendCount = 0;
    const h = makeHarness({
      sendImpl: async () => {
        sendCount += 1;
        // 第一次是建流式占位, 第二次才是补送。
        if (sendCount > 1) throw sendErr;
        return 'msg-1';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 9m');

    await expect(handle.finalize('答案')).rejects.toBe(sendErr);
    expect(h.deleted).toEqual([]);
  });

  it('旧消息删不掉不影响已送达的答案', async () => {
    const h = makeHarness({
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

  it('Rich 终稿新发成功时既不走 HTML 补送也不编辑过程消息', async () => {
    const sendFinal = vi.fn(async () => 'rich-2');
    const h = makeHarness();
    const handle = await startTelegramStreaming({ ...h.deps, sendFinal }, '⚙️ 工作中 · 4s');

    await handle.finalize('rich 定稿的答案');

    expect(sendFinal).toHaveBeenCalledWith('rich 定稿的答案', true);
    expect(h.sent).toEqual(['⚙️ 工作中 · 4s']);
    expect(h.reposted).toEqual([]);
    expect(h.deleted).toEqual(['msg-1']);
  });

  it('Rich 明确不可用时回落 HTML 补送，仍保持先发新后删旧', async () => {
    const sendFinal = vi.fn(async () => null);
    const h = makeHarness();
    const handle = await startTelegramStreaming({ ...h.deps, sendFinal }, '⚙️ 工作中 · 4s');

    await handle.finalize('降级后的答案');

    expect(sendFinal).toHaveBeenCalledWith('降级后的答案', true);
    expect(h.reposted).toEqual(['降级后的答案']);
    expect(h.deleted).toEqual(['msg-1']);
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
