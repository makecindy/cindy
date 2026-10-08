/**
 * 官方 Telegram 进度载体: msg.op 版 TelegramProgressDeps + 个人 bot 同一生命周期。
 * 覆盖: 首帧 send / 后续 edit、HTML 被拒回落 plain、not modified 视为成功、429 按
 * retryAfterMs 退避并合并到最新帧、回执未知时 send 原 opId 重发、服务端声明本轮
 * 进度不归客户端时停手、finish 的同步冲刷。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  type HookMessage,
  type HookMessageOpMessage,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';

import { createMsgOpResultRouter, isTelegramTurnOpId } from '../telegramMsgOp';
import {
  createOfficialTelegramTurnCarrier,
  isClientFinalEligible,
  TELEGRAM_DM_COMPLETION_EFFECT_ID,
} from '../telegramTurnCarrier';

const THROTTLE_MS = 1500;
const log = { info: vi.fn(), warn: vi.fn() };

function harness(
  opts: { requestId?: string; resultTimeoutMs?: number; directMessage?: boolean } = {},
) {
  const router = createMsgOpResultRouter();
  const sent: HookMessageOpMessage[] = [];
  let online = true;
  const send = (m: HookMessage): boolean => {
    if (!online) return false;
    sent.push(m as HookMessageOpMessage);
    return true;
  };
  const carrier = createOfficialTelegramTurnCarrier({
    connectionId: 'conn-1',
    requestId: opts.requestId ?? 'req-1',
    externalKey: 'telegram:group:bot:-100:u:g1',
    directMessage: opts.directMessage ?? false,
    getSend: () => (online ? send : undefined),
    router,
    log,
    ...(opts.resultTimeoutMs !== undefined ? { resultTimeoutMs: opts.resultTimeoutMs } : {}),
  });
  const last = (): HookMessageOpMessage => sent[sent.length - 1]!;
  const reply = (result: Partial<MessageOpResultPayload> & { ok: boolean }): void => {
    router.settle({ opId: last().payload.opId, ...result });
  };
  return {
    router,
    carrier,
    sent,
    last,
    reply,
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushMicrotasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  log.info.mockClear();
  log.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('官方 Telegram 进度载体(msg.op)', () => {
  it('首帧 send(HTML, purpose=turn-progress), 后续 edit 同一条消息', async () => {
    const h = harness();
    h.carrier.update('**工作中**');
    // 与个人 bot 同一尾沿节流: 窗口结束前不出站。
    expect(h.sent).toHaveLength(0);
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.last().payload).toMatchObject({
      requestId: 'req-1',
      purpose: 'turn-progress',
      scope: { externalKey: 'telegram:group:bot:-100:u:g1' },
      action: { kind: 'send', tier: 'html', text: '<b>工作中</b>' },
    });
    expect(isTelegramTurnOpId(h.last().payload.opId)).toBe(true);
    h.reply({ ok: true, messageId: '901' });
    await flushMicrotasks();

    h.carrier.update('**工作中**\n\n第二步');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.action).toMatchObject({ kind: 'edit', messageId: '901', tier: 'html' });
    h.reply({ ok: true });
    await flushMicrotasks();
  });

  it('HTML 被拒(channelErrorCode=400) → 同一帧以 plain 原 markdown 重发, 换新 opId', async () => {
    const h = harness();
    h.carrier.update('坏 <标签');
    await advance(THROTTLE_MS);
    const htmlOp = h.last().payload;
    h.reply({ ok: false, channelErrorCode: 400, error: "Bad Request: can't parse entities" });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(2);
    const plainOp = h.last().payload;
    expect(plainOp.action).toMatchObject({ kind: 'send', tier: 'plain', text: '坏 <标签' });
    expect(plainOp.opId).not.toBe(htmlOp.opId);
    h.reply({ ok: true, messageId: '7' });
    await flushMicrotasks();

    // edit 的 400 回落剥标签纯文本(与个人 editHtml 同一判据)。
    h.carrier.update('**粗体** 后续');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, channelErrorCode: 400, error: "Bad Request: can't parse entities" });
    await flushMicrotasks();
    expect(h.last().payload.action).toMatchObject({
      kind: 'edit',
      messageId: '7',
      tier: 'plain',
      text: '粗体 后续',
    });
  });

  it('message is not modified 视为成功: 不回落、不重试', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    h.reply({
      ok: false,
      channelErrorCode: 400,
      error: 'Bad Request: message is not modified: specified new message content is the same',
    });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(2);
    // 同一帧不会再发(已视为显示成功)。
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(2);
  });

  it('429 按 retryAfterMs 退避, 期间的新帧合并, 窗口后只发最新一帧', async () => {
    const h = harness();
    h.carrier.update('第 1 帧');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();

    h.carrier.update('第 2 帧');
    await advance(THROTTLE_MS);
    const limited = h.last().payload;
    h.reply({ ok: false, channelErrorCode: 429, retryAfterMs: 10_000, error: 'Too Many Requests' });
    await flushMicrotasks();
    // 退避期间新帧只进缓冲, 不出站。
    h.carrier.update('第 3 帧');
    await advance(THROTTLE_MS);
    h.carrier.update('第 4 帧');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(2);

    // retry_after 到点: 在途那次按 429 规则重试一次(新 opId), 之后合并发最新帧。
    await advance(10_000);
    expect(h.sent).toHaveLength(3);
    expect(h.last().payload.opId).not.toBe(limited.opId);
    h.reply({ ok: true });
    await flushMicrotasks();
    await advance(THROTTLE_MS);
    const texts = h.sent.map((m) => (m.payload.action as { text?: string }).text);
    expect(texts[texts.length - 1]).toBe('第 4 帧');
    expect(texts).not.toContain('第 3 帧');
  });

  it('回执未知(超时)时首帧 send 原样重发(同 opId 同正文), 对账成功后补 edit 到最新帧', async () => {
    const h = harness({ resultTimeoutMs: 5_000 });
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    const first = h.last().payload;
    await advance(5_000);
    h.carrier.update('A 继续');
    await advance(THROTTLE_MS);
    // 服务端按 opId + 内容指纹去重: 换正文会撞 IDEMPOTENCY_CONFLICT, 所以原样重发。
    expect(h.last().payload).toEqual(first);
    h.reply({ ok: true, messageId: '42' });
    await flushMicrotasks();
    expect(h.last().payload.action).toMatchObject({
      kind: 'edit',
      messageId: '42',
      text: 'A 继续',
    });
  });

  it('OUTCOME_UNKNOWN 与超时同处理: 不换 opId', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    const first = h.last().payload;
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_OUTCOME_UNKNOWN });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(h.last().payload).toEqual(first);
  });

  it('服务端限速拒收(RATE_LIMITED + retryAfterMs)按 429 退避', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_RATE_LIMITED, retryAfterMs: 4_000 });
    await flushMicrotasks();
    await advance(3_000);
    expect(h.sent).toHaveLength(1);
    await advance(1_000);
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.opId).toBe('req-1:progress:send:1');
  });

  it('发不出去(离线)不占在途槽, 恢复后以原 send opId 重试', async () => {
    const h = harness();
    h.setOnline(false);
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(0);
    h.setOnline(true);
    h.carrier.update('A 继续');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.last().payload.opId).toBe('req-1:progress:send:0');
  });

  it('明确失败后 send 换号, 不拿回同一份失败', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, error: 'boom' });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(h.last().payload.opId).toBe('req-1:progress:send:1');
  });

  it('服务端回 PROGRESS_UNAVAILABLE(私聊草稿 / 已收口) → 本轮不再发任何进度 op', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE });
    await flushMicrotasks();
    h.carrier.update('B');
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(1);
  });

  it('NO_REPLY 哨兵(及其流式前缀)不落地 —— 与个人 driver 同一判据', async () => {
    const h = harness();
    h.carrier.update('NO_');
    await advance(THROTTLE_MS);
    h.carrier.update('NO_REPLY');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(0);
  });

  it('finish: 管道空闲时同步交出最新帧(先于随后的 turn.end), 之后永不出站', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.reply({ ok: true, messageId: '1' });
    await flushMicrotasks();
    h.carrier.update('最后一帧');
    // 尾沿窗口还没到 —— finish 必须同步冲刷, 不能等定时器。
    h.carrier.finish();
    expect(h.sent).toHaveLength(2);
    expect(h.last().payload.action).toMatchObject({ kind: 'edit', text: '最后一帧' });
    h.carrier.update('迟到');
    await advance(THROTTLE_MS * 3);
    expect(h.sent).toHaveLength(2);
  });

  it('close 不冲刷; 关闭后迟到的 400 也不再回落', async () => {
    const h = harness();
    h.carrier.update('A');
    await advance(THROTTLE_MS);
    h.carrier.close();
    h.reply({ ok: false, channelErrorCode: 400, error: "can't parse entities" });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(1);
  });

  it('不同轮次的 opId 互不相同(按 requestId 派生), 回执不串轮', async () => {
    const a = harness({ requestId: 'req-a' });
    const b = harness({ requestId: 'req-b' });
    a.carrier.update('A');
    b.carrier.update('B');
    await advance(THROTTLE_MS);
    expect(a.last().payload.opId).not.toBe(b.last().payload.opId);
    // b 的回执投到 a 的路由器上: a 不认, 仍在等自己的。
    expect(a.router.settle({ opId: b.last().payload.opId, ok: true, messageId: '2' })).toBe(false);
  });
});

describe('createMsgOpResultRouter', () => {
  it('发送失败 / 断线 / 超时都以 null 收口, 不悬挂', async () => {
    const router = createMsgOpResultRouter();
    const msg = {} as HookMessage;
    await expect(router.request('c', () => false, msg, 'op-a')).resolves.toBeNull();

    const pending = router.request('c', () => true, msg, 'op-b');
    router.failConnection('c');
    await expect(pending).resolves.toBeNull();

    const timed = router.request('c', () => true, msg, 'op-c', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timed).resolves.toBeNull();

    const ok = router.request('c', () => true, msg, 'op-d');
    expect(router.settle({ opId: 'op-d', ok: true })).toBe(true);
    await expect(ok).resolves.toEqual({ opId: 'op-d', ok: true });
    expect(router.settle({ opId: 'op-d', ok: true })).toBe(false);
  });
});

/**
 * 终稿用自动应答: 每发一帧就按 responder 的决定回执(在下一个微任务里, 模拟服务端异步)。
 * responder 返回 null = 不回执(回执未知, 靠超时收口)。
 */
function autoHarness(
  responder: (payload: HookMessageOpMessage['payload']) => Partial<MessageOpResultPayload> | null,
  opts: { directMessage?: boolean; resultTimeoutMs?: number } = {},
) {
  const router = createMsgOpResultRouter();
  const sent: HookMessageOpMessage[] = [];
  const carrier = createOfficialTelegramTurnCarrier({
    connectionId: 'conn-1',
    requestId: 'req-1',
    externalKey: 'telegram:dm:bot:42',
    directMessage: opts.directMessage ?? false,
    getSend: () => (m: HookMessage) => {
      const op = m as HookMessageOpMessage;
      sent.push(op);
      const result = responder(op.payload);
      if (result)
        queueMicrotask(() => router.settle({ opId: op.payload.opId, ok: true, ...result }));
      return true;
    },
    router,
    log,
    resultTimeoutMs: opts.resultTimeoutMs ?? 1_000,
  });
  return { carrier, sent };
}

let nextId = 100;
const okWithId = () => ({ ok: true, messageId: String(nextId++) });

describe('官方 Telegram 终稿由客户端发布(turn-final)', () => {
  it('有过程载体: Rich 新发终稿首段(私聊挂完成特效), 落地后删掉过程消息, 完整确认', async () => {
    const h = autoHarness(() => okWithId(), { directMessage: true });
    h.carrier.update('**工作中**');
    await advance(THROTTLE_MS);
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '**答案**' });
    await advance(0);
    await expect(done).resolves.toBe(true);
    const kinds = h.sent.map((m) => [
      m.payload.purpose,
      m.payload.action.kind,
      m.payload.finalPart,
    ]);
    expect(kinds).toEqual([
      ['turn-progress', 'send', undefined],
      ['turn-final', 'send', 0],
      ['turn-progress', 'delete', undefined],
    ]);
    expect(h.sent[1].payload.action).toMatchObject({
      tier: 'rich',
      text: '**答案**',
      effectId: TELEGRAM_DM_COMPLETION_EFFECT_ID,
    });
  });

  it('Rich 被拒(400) → 同一段 HTML 新发(换 opId); 群里不挂特效', async () => {
    const h = autoHarness((p) =>
      p.action.kind === 'send' && p.action.tier === 'rich'
        ? { ok: false, channelErrorCode: 400, error: 'Bad Request: rich message unsupported' }
        : okWithId(),
    );
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '**答案**' });
    await advance(0);
    await expect(done).resolves.toBe(true);
    const finals = h.sent.filter((m) => m.payload.purpose === 'turn-final');
    expect(finals.map((m) => (m.payload.action as { tier?: string }).tier)).toEqual([
      'rich',
      'html',
    ]);
    expect(finals[0].payload.opId).not.toBe(finals[1].payload.opId);
    expect(finals[1].payload.action).toMatchObject({ text: '<b>答案</b>' });
    expect((finals[1].payload.action as { effectId?: string }).effectId).toBeUndefined();
  });

  it.each([
    [403, 'Forbidden'],
    [429, 'Too Many Requests'],
  ])('Rich 收到其它确定 4xx(%i) → 同样回落 HTML, 不交回服务端', async (code, error) => {
    const h = autoHarness((p) =>
      p.action.kind === 'send' && p.action.tier === 'rich'
        ? { ok: false, channelErrorCode: code, error }
        : okWithId(),
    );
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(THROTTLE_MS * 10);
    await expect(done).resolves.toBe(true);
    const tiers = h.sent
      .filter((m) => m.payload.purpose === 'turn-final')
      .map((m) => (m.payload.action as { tier?: string }).tier);
    expect(tiers.at(-1)).toBe('html');
  });

  it('Rich 遇服务端自判拒绝码(无渠道错误码) → 不回落, 交回服务端', async () => {
    const h = autoHarness((p) =>
      p.purpose === 'turn-final' ? { ok: false, errorCode: 'PERSIST_FAILED' } : okWithId(),
    );
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(0);
    await expect(done).resolves.toBe(false);
    expect(h.sent.filter((m) => m.payload.purpose === 'turn-final')).toHaveLength(1);
  });

  it('长正文按个人 bot 同一分段逐段发布, finalPart 递增', async () => {
    const h = autoHarness((p) =>
      p.action.kind === 'send' && p.action.tier === 'rich'
        ? { ok: false, channelErrorCode: 404, error: 'Not Found' }
        : okWithId(),
    );
    const longText = Array.from({ length: 4 }, (_, i) => `段落 ${i} ${'字'.repeat(2000)}`).join(
      '\n\n',
    );
    const done = h.carrier.publishFinal({ status: 'ok', finalText: longText });
    await advance(0);
    await expect(done).resolves.toBe(true);
    const finals = h.sent.filter(
      (m) =>
        m.payload.purpose === 'turn-final' &&
        !(m.payload.action.kind === 'send' && m.payload.action.tier === 'rich'),
    );
    const parts = finals.map((m) => m.payload.finalPart);
    expect(parts).toEqual([...parts].sort((a, b) => a! - b!));
    expect(new Set(parts).size).toBe(parts.length);
    expect(finals.filter((m) => m.payload.action.kind === 'send').length).toBeGreaterThan(1);
  });

  it('终稿回执一直未知 → 同 opId 同正文有界重发对账, 仍未知才不确认(交回服务端)', async () => {
    const h = autoHarness((p) => (p.purpose === 'turn-final' ? null : okWithId()));
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(5_000);
    await expect(done).resolves.toBe(false);
    const finals = h.sent.filter((m) => m.payload.purpose === 'turn-final');
    // 首发 + 2 次原样重发; 不换 opId、不回落 HTML(没有应答就不能判定 Rich 没落地)。
    expect(finals).toHaveLength(3);
    expect(finals[1].payload).toEqual(finals[0].payload);
    expect(finals[2].payload).toEqual(finals[0].payload);
  });

  it('终稿回执未知、重发时服务端回显原结果 → 对上账, 照常确认', async () => {
    let seen = 0;
    const h = autoHarness((p) => {
      if (p.purpose !== 'turn-final') return okWithId();
      seen += 1;
      return seen === 1 ? { ok: false, errorCode: MESSAGE_OP_ERROR_OUTCOME_UNKNOWN } : okWithId();
    });
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(0);
    await expect(done).resolves.toBe(true);
    const finals = h.sent.filter((m) => m.payload.purpose === 'turn-final');
    expect(finals).toHaveLength(2);
    expect(finals[1].payload.opId).toBe(finals[0].payload.opId);
  });

  it('TURN_UNAVAILABLE → 不确认, 之后不再出站', async () => {
    const h = autoHarness(() => ({ ok: false, errorCode: 'TURN_UNAVAILABLE' }));
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(0);
    await expect(done).resolves.toBe(false);
    const count = h.sent.length;
    h.carrier.update('迟到');
    await advance(THROTTLE_MS * 2);
    expect(h.sent).toHaveLength(count);
  });

  it('私聊草稿模式: 进度与终稿都被收回 → 只试一次终稿 op, 不回落纯文本, 交回服务端', async () => {
    const h = autoHarness((p) =>
      p.purpose === 'turn-progress'
        ? { ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE }
        : { ok: false, errorCode: 'TURN_UNAVAILABLE' },
    );
    h.carrier.update('工作中');
    await advance(THROTTLE_MS);
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(0);
    await expect(done).resolves.toBe(false);
    expect(h.sent.filter((m) => m.payload.purpose === 'turn-final')).toHaveLength(1);
  });

  it('进度被服务端收回后, 终稿是否可发由终稿 op 自己的回执决定(本端不预判)', async () => {
    const h = autoHarness((p) =>
      p.purpose === 'turn-progress'
        ? { ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE }
        : okWithId(),
    );
    h.carrier.update('工作中');
    await advance(THROTTLE_MS);
    const done = h.carrier.publishFinal({ status: 'ok', finalText: '答案' });
    await advance(0);
    await expect(done).resolves.toBe(true);
    expect(h.sent.filter((m) => m.payload.purpose === 'turn-final')).toHaveLength(1);
  });
});

describe('isClientFinalEligible', () => {
  it('只覆盖成功、非空、非 NO_REPLY、不带附件的轮次', () => {
    expect(isClientFinalEligible({ status: 'ok', finalText: '答案' })).toBe(true);
    expect(isClientFinalEligible({ status: 'error', finalText: '答案' })).toBe(false);
    expect(isClientFinalEligible({ status: 'cancelled', finalText: '答案' })).toBe(false);
    expect(isClientFinalEligible({ status: 'ok', finalText: '  ' })).toBe(false);
    expect(isClientFinalEligible({ status: 'ok', finalText: ' NO_REPLY ' })).toBe(false);
    // 带附件整轮交回服务端: 持久兜底只存文本, 本端上传中途退出会丢附件。
    expect(
      isClientFinalEligible({
        status: 'ok',
        finalText: '答案',
        attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AA' }],
      }),
    ).toBe(false);
    expect(isClientFinalEligible({ status: 'ok', finalText: '答案', attachments: [] })).toBe(true);
  });
});
