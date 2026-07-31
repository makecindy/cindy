/**
 * 空洞补齐在会话屏幕上的接线守卫。
 *
 * 补齐算法本身在 `historyWindowGap.test.ts` 有行为测试;这里锁住屏幕侧那几个"删掉也照样跑、
 * 但会悄悄踩坑"的前置条件 —— 它们各自对应一个具体故障:
 *  - 窗口没与被控端对账过就动手 → 基于冷开缓存快照找的空洞随即被整窗替换作废,白发请求;
 *  - 不与「加载更早」/ 自身飞行互斥 → 两条 before 游标并发翻页,窗口反复 merge;
 *  - 每处空洞不去重、不设总闸 → messages 每变一次就重新发请求,一路往上翻整场历史;
 *  - isCancelled 只比 effect 闭包里的 sessionId → 那个值恒等于启动时的值,等于没有取消;
 *  - 不检查锚点行是否还在窗口 → /clear、rewind 之后把刚被移除的历史 merge 回去。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('history window backfill wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

  it('只在窗口已与被控端对账后动手，并与加载中/加载更早/自身飞行互斥', () => {
    expect(source).toContain('if (!deviceId || !sessionId || lastSyncedAt === null) return;');
    expect(source).toContain('if (loading || loadingEarlier || backfillInFlightRef.current) return;');
  });

  it('每处空洞只尝试一次，且每次打开设总闸', () => {
    expect(source).toContain('if (attempted.keys.has(gapKey)) return;');
    expect(source).toContain('if (attempted.keys.size >= 3) return;');
    // 换会话时连同 sid 一起重置,否则上个会话的已尝试集合会压住新会话的补齐。
    expect(source).toContain('backfillAttemptedGapsRef.current?.sid === sessionId');
  });

  it('取消判定走会话镜像 ref 与锚点行是否仍在窗口，不是 effect 闭包里的 sessionId', () => {
    expect(source).toContain('backfillSessionRef.current = sessionId;');
    expect(source).toContain('isCancelled: () => backfillSessionRef.current !== sessionIdAtStart');
    expect(source).toContain('.some((row) => row.id === gap.newerId)');
  });

  it('补齐失败不写 error / loadingEarlier：它是静默自愈，不占用户可见的加载态', () => {
    const effectStart = source.indexOf('const backfillAttemptedGapsRef');
    const effectEnd = source.indexOf('const selectSlashCommand', effectStart);
    expect(effectStart).toBeGreaterThan(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effectSource = source.slice(effectStart, effectEnd);
    expect(effectSource).not.toContain('setError(');
    expect(effectSource).not.toContain('setLoadingEarlier(');
  });

  it('探测页不沿用默认降级阶梯（第一枪就满页则探测白花），翻页页保留降级重试', () => {
    expect(source).toContain('limit === HISTORY_GAP_PROBE_LIMIT ? [HISTORY_GAP_PROBE_LIMIT] : undefined,');
  });
});
