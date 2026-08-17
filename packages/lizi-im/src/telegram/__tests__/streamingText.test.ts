import { describe, expect, it, vi } from 'vitest';

import {
  startTelegramStreaming,
  TelegramFinalUnconfirmedError,
  type TelegramStreamingDeps,
} from '../streamingText.js';

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

  it('分段中途失败后重试不重发任何已出站的段落', async () => {
    let failTail = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        // 第二段第一次抛错 —— 无法区分 Telegram 到底收到没有。
        if (markdown === '第二段' && failTail) throw new Error('sendMessage failed: 429');
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 8m');

    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toThrow(/429/);
    expect(h.reposted).toEqual(['第一段']);

    failTail = false;
    // 第二段回执不确定 → 不重发(可能已落地), 只补第三段; 但这一轮没完整确认,
    // 所以 finalize 以 TelegramFinalUnconfirmedError 收尾而非静默成功。
    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toBeInstanceOf(
      TelegramFinalUnconfirmedError,
    );

    // 首段与第二段都不再重发, 第三段照常补上。
    expect(h.reposted).toEqual(['第一段']);
    expect(h.sent).toEqual(['⚙️ 工作中 · 8m', '第二段', '第三段']);
  });

  it('分段被 Telegram 明确拒绝(4xx)时保留该段, 重试补齐不缺段', async () => {
    // 4xx = 报文完整往返、Telegram 拒绝了这一段, 聊天里不可能出现它。
    // 若按"可能已送达"跳过, 重试后照样 markFinalSent 并清掉过程载体 —— 答案缺段。
    let rejectTail = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第二段' && rejectTail) {
          throw Object.assign(new Error('telegram sendMessage failed: 400 Bad Request'), {
            errorCode: 400,
          });
        }
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 5m');

    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toThrow(/400/);

    rejectTail = false;
    await handle.finalize('第一段|第二段|第三段');

    // 第二段确定未送达 → 必须重发; 首段已可见 → 绝不重发。
    expect(h.reposted).toEqual(['第一段']);
    expect(h.sent).toEqual(['⚙️ 工作中 · 5m', '第二段', '第二段', '第三段']);
  });

  it('429 是明确拒绝: 该段保留待重试, 不缺段', async () => {
    // 2026-08-11 review 更正: api.ts 的 parseResponse 只在读回完整响应体后才
    // 构造带 errorCode 的错误 —— 带 errorCode 的 429 是 Telegram 应答的限流
    // 拒绝("这条我没收"), 不是回执丢失。真正的未知回执在 fetch 层就抛原生
    // 错误, 没有 errorCode。
    let flood = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第二段' && flood) {
          throw Object.assign(new Error('telegram sendMessage failed: 429'), { errorCode: 429 });
        }
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 7m');

    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toThrow(/429/);
    flood = false;
    await handle.finalize('第一段|第二段|第三段');

    // 第二段确定未送达 → 必须重发。
    expect(h.sent).toEqual(['⚙️ 工作中 · 7m', '第二段', '第二段', '第三段']);
  });

  it('无 errorCode 的网络错误按回执未知处理(不重发, 避免整篇重复)', async () => {
    // fetch 层的连接中断走不到 parseResponse, 没有 errorCode —— 无法证明
    // Telegram 没收到, 重试跳过它, 宁可缺一段也不整篇重复。
    let broken = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第二段' && broken) throw new Error('fetch failed: ECONNRESET');
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 7m');

    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toThrow(/ECONNRESET/);
    broken = false;
    await expect(handle.finalize('第一段|第二段|第三段')).rejects.toBeInstanceOf(
      TelegramFinalUnconfirmedError,
    );

    expect(h.sent).toEqual(['⚙️ 工作中 · 7m', '第二段', '第三段']);
  });

  it('首段未知回执时不重铸整条终稿, 重试只补后续分段', async () => {
    // 首条终稿已被 Telegram 接受但响应中断: deliveredChunks 若停在 0,
    // 重试会给用户再发一份完整答案。
    let broken = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第一段' && broken) throw new Error('socket hang up');
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 6m');

    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/socket hang up/);
    broken = false;
    // 首段按已送达记账(不重铸整篇), 但它从未确认 —— 这一轮以未确认收尾。
    const err = await handle.finalize('第一段|第二段').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFinalUnconfirmedError);
    expect((err as TelegramFinalUnconfirmedError).firstChunkConfirmed).toBe(false);

    // 首段不重发; 只补第二段。
    expect(h.reposted).toEqual(['第一段']);
    expect(h.sent).toEqual(['⚙️ 工作中 · 6m', '第二段']);
  });

  it('首段被明确拒绝时保持未投递, 重试重发整条终稿', async () => {
    let rejected = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第一段' && rejected) {
          throw Object.assign(new Error('telegram failed: 400'), { errorCode: 400 });
        }
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 6m');

    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/400/);
    rejected = false;
    await handle.finalize('第一段|第二段');

    // 确定未送达 → 首段必须重发。
    expect(h.reposted).toEqual(['第一段', '第一段']);
  });

  it('从未确认送达时不清理过程载体(既没答案也没现场是最坏结果)', async () => {
    // fetch 在请求写出前就失败(DNS/连接建立失败): deliveredChunks 被推满防重复,
    // 但内容其实从未出现在聊天里。此时删掉载体会让用户什么都看不到。
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown.startsWith('⚙️')) return 'carrier-msg';
        throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 4m');

    await expect(handle.finalize('唯一的答案')).rejects.toThrow(/ENOTFOUND/);

    // 重试: deliveredChunks 已被推满(防重复), 于是全部分段被跳过、不再有 I/O。
    // 但从未确认过任何一次送达 —— 不能删载体(否则既没答案也没现场), 也不能静默
    // 成功(上游会当成收口)。
    const err = await handle.finalize('唯一的答案').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFinalUnconfirmedError);
    expect((err as TelegramFinalUnconfirmedError).firstChunkConfirmed).toBe(false);
    expect(h.deleted).toEqual([]);
    // 载体还在, 上游仍可凭它判断这一轮没收口。
    expect(h.sent).toEqual(['⚙️ 工作中 · 4m']);
  });

  it('首段未确认时, 尾段成功也不清理载体(尾段证明不了首段送达)', async () => {
    // 首段 DNS 失败(未知回执) → 计数推进防重复; 重试跳过首段、尾段成功。
    // 一个全局"确认过"布尔会被尾段置真并误删现场, 用户只剩尾段。
    let firstBroken = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown.startsWith('⚙️')) return 'carrier-msg';
        if (markdown === '第一段' && firstBroken) {
          throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
        }
        return 'msg-x';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 9m');

    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/ENOTFOUND/);
    firstBroken = false;
    // 重试: 首段被跳过(计数已推进), 第二段发出并成功 —— 但尾段的成功回执证明
    // 不了首段被接受, 所以这一轮仍以未确认收尾。
    const err = await handle.finalize('第一段|第二段').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFinalUnconfirmedError);
    expect((err as TelegramFinalUnconfirmedError).firstChunkConfirmed).toBe(false);

    expect(h.sent).toContain('第二段');
    // 首段从未确认 → 载体必须留着。
    expect(h.deleted).toEqual([]);
  });

  it('首段未确认时暂停图片上传, 不把载体 id 当锚点', async () => {
    // messageIdValue 这时还是过程载体 ID: 把图挂上去, 载体一旦被删图就没了。
    let broken = true;
    const h = makeHarness({
      extractImageUrls: () => ['cindy-media://blobs/a.png'],
      sendImpl: async (markdown) => {
        if (markdown.startsWith('⚙️')) return 'carrier-msg';
        if (broken) throw new Error('socket hang up');
        return 'final-msg';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 3m');

    await expect(handle.finalize('带图的答案')).rejects.toThrow(/socket hang up/);
    // 重试时首段被跳过(未知回执已计数), 但没有真实终稿 id —— 必须拒绝上传。
    await expect(handle.finalize('带图的答案')).rejects.toThrow(/unconfirmed/);
    expect(h.uploadAnchors).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it('有未确认分段时不进 final-sent, 后续 finalize 仍能进来对账', async () => {
    // 关键: finalize() 开头会让 final-sent / complete 直接 return。若未确认分段
    // 存在却提前收口, 这一轮再也无法补投, 而调用方还以为成功了。
    let tailBroken = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第二段' && tailBroken) throw new Error('socket hang up');
        return markdown.startsWith('⚙️') ? 'carrier-msg' : 'final-msg';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 5m');

    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/socket hang up/);
    tailBroken = false;

    // 第二段回执未知 → 不重投(可能已落地), 也不宣布收口, 且必须让调用方看见:
    // 静默 resolve 会被上游当成收口成功。
    const err = await handle.finalize('第一段|第二段').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFinalUnconfirmedError);
    expect((err as TelegramFinalUnconfirmedError).firstChunkConfirmed).toBe(true);
    expect((err as TelegramFinalUnconfirmedError).unconfirmedChunks).toEqual([1]);
    expect(h.deleted).toEqual([]);

    // 未收口 ⇒ 状态没被锁死, 后续 finalize 仍会真正执行(而非被 final-sent 挡在
    // 第一行直接 return)。用一次会抛错的图片上传把"确实走进了主体"钉住。
    h.deps.extractImageUrls = () => ['cindy-media://blobs/x.png'];
    h.deps.uploadImages = async () => {
      throw new Error('probe: finalize body executed');
    };
    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/probe/);
    expect(h.sent.filter((t) => t === '第二段')).toHaveLength(1); // 始终不重投
  });

  it('全部分段确认后正常进入 final-sent 并清理载体', async () => {
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) =>
        markdown.startsWith('⚙️') ? 'carrier-msg' : 'final-msg',
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 2m');

    await handle.finalize('第一段|第二段');
    expect(h.deleted).toEqual(['carrier-msg']);

    // 已收口: 再次 finalize 直接返回, 不产生任何出站。
    const sentBefore = h.sent.length;
    await handle.finalize('第一段|第二段');
    expect(h.sent).toHaveLength(sentBefore);
  });

  it('多批图片: 后批失败后重试从断点续传, 不重复已发附件', async () => {
    const uploaded: Array<{ start: number; count: number }> = [];
    let failSecondBatch = true;
    const h = makeHarness({ extractImageUrls: () => Array.from({ length: 15 }, (_, i) => `img-${i}`) });
    h.deps.uploadImages = async (_messageId, refs, opts) => {
      const start = opts?.startIndex ?? 0;
      uploaded.push({ start, count: refs.length - start });
      // 第一批 10 张成功, 第二批失败。
      opts?.onProgress?.(Math.max(start, 10));
      if (failSecondBatch) {
        failSecondBatch = false;
        throw new Error('sendMediaGroup failed');
      }
    };
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 2m');

    await expect(handle.finalize('带图答案')).rejects.toThrow(/sendMediaGroup/);
    await handle.finalize('带图答案');

    // 第二次从第 10 张开始, 不重传前 10 张。
    expect(uploaded).toEqual([
      { start: 0, count: 15 },
      { start: 10, count: 5 },
    ]);
  });

  it('清理的是原始过程载体, 不是已经送达的终稿', async () => {
    // 首段成功后 messageIdValue 已指向终稿; 若从它重算清理目标, 会把答案删掉
    // 而留下过程载体。全程确认(无未知回执)时才走到清理。
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) =>
        // 过程载体与终稿必须是不同的 messageId, 否则这条断言没有意义。
        markdown.startsWith('⚙️') ? 'carrier-msg' : 'final-msg',
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 12m');
    const carrierId = handle.messageId;
    expect(carrierId).toBe('carrier-msg');

    await handle.finalize('第一段|第二段');

    // 首段落地后 handle 指向终稿; 删的必须是最初那条过程消息。
    expect(handle.messageId).not.toBe(carrierId);
    expect(h.deleted).toEqual([carrierId]);
    expect(h.deleted).not.toContain(handle.messageId);
  });

  it('尾段回执未知时保留载体: 重试跳过它, 但正文未完整确认', async () => {
    // 尾段 500 属于回执未知 —— 不重投(避免重复), 但也不能据此宣称收口。
    let failTail = true;
    const h = makeHarness({
      chunk: (text) => text.split('|'),
      sendImpl: async (markdown) => {
        if (markdown === '第二段' && failTail) throw new Error('sendMessage failed: 500');
        return markdown.startsWith('⚙️') ? 'carrier-msg' : 'final-msg';
      },
    });
    const handle = await startTelegramStreaming(h.deps, '⚙️ 工作中 · 12m');

    await expect(handle.finalize('第一段|第二段')).rejects.toThrow(/500/);
    failTail = false;
    // 重试: 第二段已计数(防重复)故被跳过, 但它始终没拿到回执 —— 以未确认收尾。
    const err = await handle.finalize('第一段|第二段').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramFinalUnconfirmedError);
    expect((err as TelegramFinalUnconfirmedError).unconfirmedChunks).toEqual([1]);

    // 第二段只发过一次(没有重投), 且因未确认而保留现场。
    expect(h.sent.filter((t) => t === '第二段')).toHaveLength(1);
    expect(h.deleted).toEqual([]);
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
