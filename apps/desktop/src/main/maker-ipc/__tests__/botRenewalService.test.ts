/**
 * 到点换代的接线层。
 *
 * 判定本身在 `shared/botRenewalPolicy.ts` 有自己的一组用例;这里盯的是接线上
 * **不该发生的事**:暂停的伙伴被动起来、CAS 失败还告诉用户「我们重新开始了」、
 * 一步出错就让人连伙伴都打不开。
 */

import { describe, expect, it, vi } from 'vitest';

import { renewBotSessionIfDue, type BotRenewalDeps } from '../botRenewalService';

const YESTERDAY_EVENING = new Date(2026, 7, 22, 22).getTime();
const THIS_MORNING = new Date(2026, 7, 23, 9).getTime();

function harness(over: Partial<BotRenewalDeps> & { snapshot?: unknown } = {}) {
  const renew = vi.fn(async () => ({ canonicalSessionId: 's-new' }));
  const recordEvent = vi.fn(async () => {});
  const deps: BotRenewalDeps = {
    readSnapshot: async () =>
      (over.snapshot === undefined
        ? {
            botId: 'bot-a',
            renewal: undefined,
            canonicalSessionId: 's-old',
            currentVersion: 3,
            status: 'active',
          }
        : over.snapshot) as never,
    readLastActivityAt: async () => YESTERDAY_EVENING,
    hasActiveWork: async () => false,
    renew,
    recordEvent,
    now: () => THIS_MORNING,
    ...over,
  };
  return { deps, renew, recordEvent };
}

describe('到点换代', () => {
  it('到了新的一天就替换物理 Session，但保留 Bot 身份', async () => {
    const h = harness();
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out).toEqual({
      renewed: true,
      reason: 'daily',
      canonicalSessionId: 's-new',
      notify: false,
    });
    expect(h.renew).toHaveBeenCalledWith({
      botId: 'bot-a',
      expectedCanonicalSessionId: 's-old',
      expectedProfileVersion: 3,
    });
    expect(h.recordEvent).toHaveBeenCalledWith({
      botId: 'bot-a',
      reason: 'daily',
      from: 's-old',
      to: 's-new',
    });
  });

  it('今天已经聊过就不换', async () => {
    const h = harness({ readLastActivityAt: async () => THIS_MORNING - 60_000 });
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out.renewed).toBe(false);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it('暂停 / 归档的伙伴不会被动起来', async () => {
    for (const status of ['paused', 'archived', 'deleting', 'error']) {
      const h = harness({
        snapshot: {
          botId: 'bot-a',
          renewal: undefined,
          canonicalSessionId: 's-old',
          currentVersion: 3,
          status,
        },
      });
      const out = await renewBotSessionIfDue('bot-a', h.deps);
      expect(out.renewed).toBe(false);
      expect(h.renew).not.toHaveBeenCalled();
    }
  });

  it('还没有主对话时不算换代 —— 那是「首次创建」的事', async () => {
    const h = harness({
      snapshot: {
        botId: 'bot-a',
        renewal: undefined,
        canonicalSessionId: null,
        currentVersion: 1,
        status: 'active',
      },
    });
    expect((await renewBotSessionIfDue('bot-a', h.deps)).renewed).toBe(false);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it('关掉换代就不动它', async () => {
    const h = harness({
      snapshot: {
        botId: 'bot-a',
        renewal: { mode: 'none' },
        canonicalSessionId: 's-old',
        currentVersion: 3,
        status: 'active',
      },
    });
    expect((await renewBotSessionIfDue('bot-a', h.deps)).renewed).toBe(false);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it('还有活儿在跑就不换 —— 那些活儿回来要往这段对话里报结果', async () => {
    const h = harness({ hasActiveWork: async () => true });
    expect((await renewBotSessionIfDue('bot-a', h.deps)).renewed).toBe(false);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it('CAS 失败(底座返回同一条)时不谎报换代', async () => {
    // 并发下另一个入口刚换过。这时说「我们重新开始了」但人还在老对话里,
    // 比不说更糟。
    const h = harness({ renew: async () => ({ canonicalSessionId: 's-old' }) });
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out.renewed).toBe(false);
    expect(out.canonicalSessionId).toBe('s-old');
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it('并发窗口跟随 CAS 胜者，但不重复记换代事件', async () => {
    const h = harness({
      renew: async () => ({ canonicalSessionId: 's-winner', created: false }),
    });
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out).toEqual({
      renewed: false,
      canonicalSessionId: 's-winner',
      notify: false,
    });
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it('换代留痕失败不影响已经完成的 Session 交接', async () => {
    const h = harness({ recordEvent: async () => { throw new Error('db down'); } });
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out.renewed).toBe(true);
    expect(out.canonicalSessionId).toBe('s-new');
  });

  it('尊重存量 Bot 的自定义换代时刻', async () => {
    const h = harness({
      snapshot: {
        botId: 'bot-a',
        renewal: { mode: 'daily', atHour: 0 },
        canonicalSessionId: 's-old',
        currentVersion: 3,
        status: 'active',
      },
    });
    expect((await renewBotSessionIfDue('bot-a', h.deps)).renewed).toBe(true);
  });

  it('默认静默换代，不制造提示消息', async () => {
    const h = harness({
      snapshot: {
        botId: 'bot-a',
        renewal: { mode: 'daily', atHour: 6, notify: false },
        canonicalSessionId: 's-old',
        currentVersion: 3,
        status: 'active',
      },
    });
    const out = await renewBotSessionIfDue('bot-a', h.deps);
    expect(out.renewed).toBe(true);
    expect(out.notify).toBe(false);
  });
});
