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
    expect(gap).toEqual({
      newerId: 'tail',
      olderId: 'head-2',
      newerMs: BASE_MS + 140 * 60_000,
      olderMs: BASE_MS + 2 * 60_000,
      gapMs: 138 * 60_000,
    });
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

  it('空洞 key 取两侧时刻对，同毫秒组换了锚点也不变', () => {
    // 回归:key 若取两侧的行 id,探测往同毫秒组内 merge 进一行、且它的 id 字典序排到原锚点之后
    // 时,下一轮检测会挑出**同一处停顿**的另一个 id 组合 → key 变了 → 同一处被重新探测,一处
    // 停顿吃掉两次考察额度,更早的真实空洞在本次访问里仍然补不上（#1210 review）。
    const before = findHistoryWindowGap([row('older', 0), row('zzz-newer', 140)]) as HistoryWindowGap;
    // 同一毫秒又并进来一行,且 id 字典序排在原锚点之前 → 成为新的锚点。
    const after = findHistoryWindowGap([
      row('older', 0),
      row('aaa-newer', 140),
      row('zzz-newer', 140),
    ]) as HistoryWindowGap;

    expect(after.newerId).not.toBe(before.newerId);
    expect(historyWindowGapKey(after)).toBe(historyWindowGapKey(before));
    // key 只由两侧时刻决定。
    expect(historyWindowGapKey(before)).toBe(`${BASE_MS}→${BASE_MS + 140 * 60_000}`);
  });

  it('跳过已考察的跳变，继续往更早处找', () => {
    // 关键回归:contiguous（隔夜等合法间隔）既不 merge、跳变也一直留在窗口里。若检测恒定返回
    // 最靠尾部那一处，更早处的真实缺行永远进不了探测 —— 补齐只盯着这处 contiguous 收工，
    // 而「加载更早」只从最旧行往外翻、够不到窗口内部的空洞。
    const window = [row('a', 0), row('b', 100), row('c', 300)];
    const tailGap = findHistoryWindowGap(window) as HistoryWindowGap;
    expect(tailGap.newerId).toBe('c');

    const earlierGap = findHistoryWindowGap(window, new Set([historyWindowGapKey(tailGap)]));
    expect(earlierGap).toEqual({
      newerId: 'b',
      olderId: 'a',
      newerMs: BASE_MS + 100 * 60_000,
      olderMs: BASE_MS,
      gapMs: 100 * 60_000,
    });

    const bothConsidered = new Set([
      historyWindowGapKey(tailGap),
      historyWindowGapKey(earlierGap as HistoryWindowGap),
    ]);
    expect(findHistoryWindowGap(window, bothConsidered)).toBeNull();
  });
});

describe('backfillHistoryWindowGap', () => {
  const gap: HistoryWindowGap = {
    newerId: 'tail',
    olderId: 'head',
    newerMs: BASE_MS + 140 * 60_000,
    olderMs: BASE_MS + 2 * 60_000,
    gapMs: 138 * 60_000,
  };

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
    // 每页按服务端契约排列:最新在前、页尾最旧(见 nextPageCursor)。
    const pages: Record<string, RemoteMessage[]> = {
      tail: [row('mid-1', 100)],
      'mid-1': [row('mid-3', 80), row('mid-2', 60)],
      'mid-2': [row('head-2', 4), row('head', 2)],
    };
    const listPage = vi.fn(async (before: string) => pages[before] ?? []);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: (rows) => merged.push(...rows.map((r) => r.id)),
      isCancelled: () => false,
    });

    expect(outcome).toBe('covered');
    expect(merged).toEqual(['mid-1', 'mid-3', 'mid-2', 'head-2', 'head']);
    // 游标按页尾取,所以第二页是从 mid-2（页内最旧）继续往前翻。
    expect(listPage.mock.calls.map((call) => call[0])).toEqual(['tail', 'mid-1', 'mid-2']);
  });

  it('同一毫秒的多行按服务端顺序取页尾，不按 id 字典序', async () => {
    // 回归:同毫秒落库的行在客户端只剩相同 createdAt,拿 id 字典序当次级键会与服务端的
    // rowid 次序脱钩,可能挑中页内**较新**那行当游标 → 下一页把已 merge 的行再取回来,
    // 补齐在预算内只前进几行就把空洞记成 budget（#1210 review）。
    const pages: Record<string, RemoteMessage[]> = {
      // 服务端顺序（最新在前）恰好与 id 字典序相反:页尾是 zzz,字典序最小是 aaa。
      tail: [row('aaa', 100), row('mmm', 100), row('zzz', 100)],
      zzz: [row('head', 2)],
    };
    const listPage = vi.fn(async (before: string) => pages[before] ?? []);
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('covered');
    expect(listPage.mock.calls.map((call) => call[0])).toEqual(['tail', 'zzz']);
  });

  it('锚点不是同毫秒组最旧那行时，探测沿组内继续往更旧处走，仍判为真安静', async () => {
    // 回归:同毫秒落库的多行在手机端只剩相同 createdAt,服务端的次级键 rowid 不在每一行上都有
    // (push 追加的行就没有),所以检测阶段挑出的 newerId 可能不是该组最旧的一行。此时 limit=1
    // 探测会取回同组另一行 —— 按 id 精确匹配就会误判成有洞,一路翻页并把这处正常停顿记成
    // backfilled,三处这样的停顿即可耗尽翻页额度、让更早的真实空洞继续缺失（#1210 review）。
    const merge = vi.fn();
    const pages: Record<string, RemoteMessage[]> = {
      'tail-b': [row('tail-a', 140)], // 同一毫秒的另一行
      'tail-a': [row('head', 2)], // 组内走到底,前一刻就是较旧侧
    };
    const listPage = vi.fn(async (before: string) => pages[before] ?? []);
    const outcome = await backfillHistoryWindowGap({ ...gap, newerId: 'tail-b' }, {
      listPage,
      merge,
      isCancelled: () => false,
    });

    expect(outcome).toBe('contiguous');
    expect(listPage.mock.calls.map((call) => call[0])).toEqual(['tail-b', 'tail-a']);
    // 只在同毫秒组内推进,每步都是 limit=1;没有退化成整页翻页。
    expect(listPage).toHaveBeenCalledWith('tail-b', 1);
    expect(listPage).toHaveBeenCalledWith('tail-a', 1);
  });

  it('较旧侧是同毫秒组的另一行时，翻页仍判为已连上', async () => {
    // 连上判定同样不能按 olderId 精确匹配:取回同组的另一行就等价于两段之间再无缺口,
    // 按 id 比会漏判成"还没连上",于是白翻到预算耗尽、把已经补好的空洞记成 budget。
    const listPage = vi.fn()
      .mockResolvedValueOnce([row('mid-1', 100)])
      .mockResolvedValueOnce([row('head-a', 2)]); // 与 olderId('head') 同毫秒、不同 id
    const outcome = await backfillHistoryWindowGap(gap, {
      listPage,
      merge: () => undefined,
      isCancelled: () => false,
    });

    expect(outcome).toBe('covered');
    expect(listPage).toHaveBeenCalledTimes(2);
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
