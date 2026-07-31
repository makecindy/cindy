/**
 * 历史窗口空洞的检测与补齐(见 `historyWindowGap.ts` 的文件头)。
 *
 * 现场:2026-07-31 手机端打开一个 445 行的会话,窗口只有"冷开缓存的首段 + 最新页的尾段",
 * 中间 400 余行从未加载,6 轮对话在界面上凭空消失(被折进一条「已工作 142m 32s」)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HISTORY_BACKFILL_MAX_REQUESTS,
  HISTORY_BACKFILL_MAX_ROWS,
  backfillHistoryWindowGap,
  findHistoryWindowGap,
  historyWindowGapKey,
  type HistoryWindowGap,
} from '@/session/historyWindowGap';
import type { RemoteMessage } from '@/session/types';

const BASE_MS = Date.parse('2026-07-31T06:00:00.000Z');

function row(id: string, minutes: number): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 'session-1',
    role: 'assistant',
    content: 'text',
    toolUseId: null,
    agentMeta: null,
    createdAt: new Date(BASE_MS + minutes * 60_000).toISOString(),
  };
}

describe('findHistoryWindowGap', () => {
  it('连续窗口没有空洞', () => {
    expect(findHistoryWindowGap([row('a', 0), row('b', 5), row('c', 20)])).toBeNull();
  });

  it('找到跳变两侧的行', () => {
    const gap = findHistoryWindowGap([row('head', 0), row('head-2', 2), row('tail', 140)]);
    expect(gap).toEqual({ newerId: 'tail', olderId: 'head-2', gapMs: 138 * 60_000 });
  });

  it('多处跳变时取最靠尾部的一处', () => {
    // 补齐沿 before 从新往旧翻页,先补最靠尾部的洞时游标离窗口尾最近、翻页量最小。
    const gap = findHistoryWindowGap([row('a', 0), row('b', 100), row('c', 300)]);
    expect(gap?.olderId).toBe('b');
    expect(gap?.newerId).toBe('c');
  });

  it('恰好等于阈值不算空洞（严格大于才切）', () => {
    expect(findHistoryWindowGap([row('a', 0), row('b', 30)])).toBeNull();
    expect(findHistoryWindowGap([row('a', 0), row('b', 31)])?.newerId).toBe('b');
  });

  it('跳过本地合成系统卡：它没有服务端对应行，拿它当游标什么都匹配不上', () => {
    const localCard = { ...row('mobile-system-pwd-1', 200), id: 'mobile-system-pwd-1' };
    const gap = findHistoryWindowGap([row('a', 0), row('b', 2), localCard]);
    expect(gap).toBeNull();
  });

  it('时间不可解析的行不参与判定', () => {
    const broken = { ...row('broken', 0), createdAt: 'not-a-date' };
    expect(findHistoryWindowGap([row('a', 0), broken, row('b', 5)])).toBeNull();
  });

  it('空洞 key 稳定可用于去重', () => {
    const gap = findHistoryWindowGap([row('older', 0), row('newer', 140)]) as HistoryWindowGap;
    expect(historyWindowGapKey(gap)).toBe('older→newer');
  });

  it('跳过已考察的跳变，继续往更早处找', () => {
    // 关键回归:contiguous（隔夜等合法间隔）既不 merge、跳变也一直留在窗口里。若检测恒定返回
    // 最靠尾部那一处，更早处的真实缺行永远进不了探测 —— 补齐只盯着这处 contiguous 收工，
    // 而「加载更早」只从最旧行往外翻、够不到窗口内部的空洞。
    const window = [row('a', 0), row('b', 100), row('c', 300)];
    const tailGap = findHistoryWindowGap(window) as HistoryWindowGap;
    expect(tailGap.newerId).toBe('c');

    const earlierGap = findHistoryWindowGap(window, new Set([historyWindowGapKey(tailGap)]));
    expect(earlierGap).toEqual({ newerId: 'b', olderId: 'a', gapMs: 100 * 60_000 });

    const bothConsidered = new Set([
      historyWindowGapKey(tailGap),
      historyWindowGapKey(earlierGap as HistoryWindowGap),
    ]);
    expect(findHistoryWindowGap(window, bothConsidered)).toBeNull();
  });
});

describe('backfillHistoryWindowGap', () => {
  const gap: HistoryWindowGap = { newerId: 'tail', olderId: 'head', gapMs: 138 * 60_000 };

  it('探测发现两行本来就相邻 → 真安静的会话，不翻页也不 merge', async () => {
    const merge = vi.fn();
    const listPage = vi.fn(async () => [row('head', 2)]);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge,
      isCancelled: () => false,
    });

    expect(outcome).toBe('contiguous');
    // 只花一次 limit=1 的探测:正常的隔夜会话不该为此白翻整页。
    expect(listPage).toHaveBeenCalledTimes(1);
    expect(listPage).toHaveBeenCalledWith('tail', 1);
    expect(merge).not.toHaveBeenCalled();
  });

  it('探测发现别的行 → 继续翻页直到取回目标行', async () => {
    const merged: string[] = [];
    const pages: Record<string, RemoteMessage[]> = {
      tail: [row('mid-1', 100)],
      'mid-1': [row('mid-2', 60), row('mid-3', 80)],
      'mid-2': [row('head', 2), row('head-2', 4)],
    };
    const listPage = vi.fn(async (before: string) => pages[before] ?? []);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: (rows) => merged.push(...rows.map((r) => r.id)),
      isCancelled: () => false,
    });

    expect(outcome).toBe('covered');
    expect(merged).toEqual(['mid-1', 'mid-2', 'mid-3', 'head', 'head-2']);
  });

  it('判定只看本页取回的行，不看合并后的窗口', async () => {
    // 较旧那一段本来就躺在窗口里。若拿合并结果判定,随便一页(内容完全无关)都会让判定成立,
    // 空洞就永远补不回来。这里第一页不含 head → 必须继续翻。
    const listPage = vi.fn()
      .mockResolvedValueOnce([row('mid-1', 100)])
      .mockResolvedValueOnce([row('mid-2', 90)])
      .mockResolvedValueOnce([row('head', 2)]);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('covered');
    expect(listPage).toHaveBeenCalledTimes(3);
  });

  it('翻到历史起点仍未连上 → exhausted', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce([row('mid-1', 100)])
      .mockResolvedValueOnce([]);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('exhausted');
  });

  it('游标不前进 → 停手，不进死循环', async () => {
    // 被控端反复返回同一段(或整页都是没有 id 的行)时,before 会原地打转。
    const listPage = vi.fn(async () => [row('mid-1', 100)]);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('exhausted');
    expect(listPage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('超出请求数预算 → budget，交给渲染层守卫兜底', async () => {
    // 帧超限的会话会被降级成每页几行:请求数会先于行数预算耗尽。
    let seq = 0;
    const listPage = vi.fn(async () => {
      seq += 1;
      return [row(`mid-${seq}`, 100 - seq)];
    });
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('budget');
    expect(listPage).toHaveBeenCalledTimes(HISTORY_BACKFILL_MAX_REQUESTS);
  });

  it('超出行数预算 → budget', async () => {
    let seq = 0;
    const listPage = vi.fn(async () => {
      seq += 1;
      // 每页 80 行,5 页即触顶(400 行),此时请求数还远没用完。
      return Array.from({ length: 80 }, (_, index) => row(`p${seq}-${index}`, 1000 - seq * 80 - index));
    });
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('budget');
    expect(listPage.mock.calls.length).toBeLessThan(HISTORY_BACKFILL_MAX_REQUESTS);
    expect(seq * 80).toBeGreaterThanOrEqual(HISTORY_BACKFILL_MAX_ROWS);
  });

  it('会话切走 / 锚点行已被移除 → cancelled，且不再 merge', async () => {
    const merge = vi.fn();
    let cancelled = false;
    const listPage = vi.fn(async () => {
      cancelled = true;
      return [row('mid-1', 100)];
    });
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge,
      isCancelled: () => cancelled,
    });

    expect(outcome).toBe('cancelled');
    expect(merge).not.toHaveBeenCalled();
  });

  it('请求异常 → failed，不抛给调用方', async () => {
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage: async () => {
        throw new Error('offline');
      },
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('failed');
  });
});
