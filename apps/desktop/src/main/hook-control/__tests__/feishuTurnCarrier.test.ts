/**
 * 官方飞书 / Lark 的轮次载体: 个人飞书 bot 的同一份卡片排版, 经 msg.op 交给服务端执行。
 *
 * 规则: docs/dev-rules/im-turn-flow.md 「官方飞书 / Lark」与不变量 13 —— 官方 bot 不另写
 * 排版, 长回复分条完整送达、过程记录折叠, 没有完整确认时交回服务端。
 * 入口: createOfficialFeishuTurnCarrier 的 update / publishFinal; 断言 wire 上发出的
 * msg.op 与返回给 turn.end 的 complete。此前官方飞书只发 turn.progress / turn.end 文本,
 * 没有这条路径。unit tier(假定时器 + 内存里的回执路由)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  MESSAGE_OP_ERROR_TURN_UNAVAILABLE,
  type HookMessage,
  type HookMessageOpMessage,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';

import { createOfficialFeishuTurnCarrier } from '../feishuTurnCarrier';
import { createMsgOpResultRouter, isTelegramTurnOpId } from '../telegramMsgOp';

const THROTTLE_MS = 1500;
const LANE = 'feishu:dm:cli_app:ou_alice:g1';
const log = { info: vi.fn(), warn: vi.fn() };

type CardElement = { tag: string; content?: string; expanded?: boolean; header?: { title: { content: string } } };

function harness() {
  const router = createMsgOpResultRouter();
  const sent: HookMessageOpMessage[] = [];
  const carrier = createOfficialFeishuTurnCarrier({
    connectionId: 'conn-1',
    requestId: 'req-1',
    externalKey: LANE,
    getSend: () => (m: HookMessage): boolean => {
      sent.push(m as HookMessageOpMessage);
      return true;
    },
    router,
    log,
  });
  const elements = (index: number): CardElement[] => {
    const action = sent[index]!.payload.action;
    if (action.kind !== 'send' && action.kind !== 'edit') throw new Error('not a card op');
    return (JSON.parse(action.text) as { body: { elements: CardElement[] } }).body.elements;
  };
  return {
    carrier,
    router,
    sent,
    elements,
    reply(result: Partial<MessageOpResultPayload> & { ok: boolean }, index = sent.length - 1): void {
      router.settle({ opId: sent[index]!.payload.opId, ...result });
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
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

describe('官方飞书 / Lark 轮次载体(msg.op)', () => {
  it('第一帧建卡、之后原地更新, 终稿带折叠的过程记录落在同一轮', async () => {
    const h = harness();
    h.carrier.update('⚙️ 工作中 · 1 项 · 3s');
    expect(h.sent).toHaveLength(0);
    await advance(THROTTLE_MS);
    expect(h.sent[0]!.payload).toMatchObject({
      requestId: 'req-1',
      purpose: 'turn-progress',
      scope: { externalKey: LANE },
      action: { kind: 'send' },
    });
    expect(h.sent[0]!.payload.action).not.toHaveProperty('tier');
    expect(isTelegramTurnOpId(h.sent[0]!.payload.opId)).toBe(true);
    expect(h.elements(0)).toEqual([{ tag: 'markdown', content: '⚙️ 工作中 · 1 项 · 3s' }]);
    h.reply({ ok: true, messageId: 'om_card' });
    await flushMicrotasks();

    h.carrier.update('⚙️ 工作中 · 2 项 · 6s');
    await advance(THROTTLE_MS);
    expect(h.sent[1]!.payload).toMatchObject({
      purpose: 'turn-progress',
      action: { kind: 'edit', messageId: 'om_card' },
    });
    h.reply({ ok: true, messageId: 'om_card' });
    await flushMicrotasks();

    const published = h.carrier.publishFinal({
      status: 'ok',
      finalText: '结论',
      process: { title: '过程记录 · 2 项 · 8s', lines: ['✓ 读取 a.ts', '✓ 搜索 foo'] },
    });
    await flushMicrotasks();
    expect(h.sent[2]!.payload).toMatchObject({ purpose: 'turn-final', finalPart: 0, action: { kind: 'send' } });
    const [panel, body] = h.elements(2);
    expect(panel).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(panel!.header!.title.content).toBe('过程记录 · 2 项 · 8s');
    expect(body).toEqual({ tag: 'markdown', content: '结论' });
    h.reply({ ok: true, messageId: 'om_card' });
    await expect(published).resolves.toBe(true);
    expect(h.sent).toHaveLength(3);
  });

  // 规则: 回执未知的建卡必须原样重发(同 opId 同内容), 否则服务端按内容指纹拒为
  // IDEMPOTENCY_CONFLICT(评审 #9746 greptile)。入口: update → msg.op; 官方 Telegram 载体已有同款
  // 用例, 飞书载体此前没有。最小输入: 首帧回执丢失后再来一帧不同内容; unit, 假定时器。
  it('建卡回执未知后原样重发同一 opId 与卡片, 再补一次更新到最新内容', async () => {
    const h = harness();
    h.carrier.update('进度 A');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    h.router.failAll();
    await flushMicrotasks();

    h.carrier.update('进度 B');
    await advance(THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.payload.opId).toBe(h.sent[0]!.payload.opId);
    expect(h.sent[1]!.payload.action).toEqual(h.sent[0]!.payload.action);
    h.reply({ ok: true, messageId: 'om_card' });
    await flushMicrotasks();

    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]!.payload.action).toMatchObject({ kind: 'edit', messageId: 'om_card' });
    expect(h.elements(2)).toEqual([{ tag: 'markdown', content: '进度 B' }]);
  });

  it('长回复按卡片分条依次发布, 全部确认才算完整', async () => {
    const h = harness();
    const long = Array.from({ length: 4000 }, (_, i) => `第 ${i} 段内容，足够长。`).join('\n\n');
    const published = h.carrier.publishFinal({ status: 'ok', finalText: long });
    let part = 0;
    for (; ; part += 1) {
      await flushMicrotasks();
      if (h.sent.length <= part) break;
      expect(h.sent[part]!.payload).toMatchObject({ purpose: 'turn-final', finalPart: part });
      h.reply({ ok: true, messageId: `om_${part}` }, part);
    }
    await expect(published).resolves.toBe(true);
    expect(part).toBeGreaterThan(2);
    const everything = h.sent.map((_, index) => h.elements(index).map((element) => element.content ?? '').join('\n')).join('\n');
    expect(everything).toContain('第 0 段内容');
    expect(everything).toContain('第 3999 段内容');
    expect(everything).toContain(`1/${part} · 未完，接下一条`);
    expect(everything).not.toContain('桌面端');
  });

  it('后续卡片被拒时交回服务端, 不再继续发', async () => {
    const h = harness();
    const long = Array.from({ length: 4000 }, (_, i) => `第 ${i} 段内容，足够长。`).join('\n\n');
    const published = h.carrier.publishFinal({ status: 'ok', finalText: long });
    await flushMicrotasks();
    h.reply({ ok: true, messageId: 'om_0' });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(2);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_TURN_UNAVAILABLE, error: 'gone' });
    await expect(published).resolves.toBe(false);
    expect(h.sent).toHaveLength(2);
  });

  it('终稿撞限速时按服务端给的时间等待后重发', async () => {
    const h = harness();
    const published = h.carrier.publishFinal({ status: 'ok', finalText: '结论' });
    await flushMicrotasks();
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_RATE_LIMITED, error: 'slow down', retryAfterMs: 1500 });
    await flushMicrotasks();
    expect(h.sent).toHaveLength(1);
    await advance(1500);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.payload.opId).not.toBe(h.sent[0]!.payload.opId);
    h.reply({ ok: true, messageId: 'om_final' });
    await expect(published).resolves.toBe(true);
  });

  it('服务端说进度不归本端时停掉进度, 终稿仍由本端发布', async () => {
    const h = harness();
    h.carrier.update('进度 1');
    await advance(THROTTLE_MS);
    h.reply({ ok: false, errorCode: MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE, error: 'server renders' });
    await flushMicrotasks();
    h.carrier.update('进度 2');
    await advance(THROTTLE_MS * 2);
    expect(h.sent).toHaveLength(1);

    const published = h.carrier.publishFinal({ status: 'ok', finalText: '结论' });
    await flushMicrotasks();
    expect(h.sent[1]!.payload).toMatchObject({ purpose: 'turn-final', finalPart: 0 });
    h.reply({ ok: true, messageId: 'om_final' });
    await expect(published).resolves.toBe(true);
  });

  it.each([
    ['失败', { status: 'error' as const, finalText: '半截' }],
    ['带附件', { status: 'ok' as const, finalText: '结论', attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AA==' }] }],
    ['空正文', { status: 'ok' as const, finalText: ' ' }],
  ])('%s的轮次不由本端发布终稿', async (_name, input) => {
    const h = harness();
    await expect(h.carrier.publishFinal(input)).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});
