/**
 * 空洞补齐在会话屏幕上的接线守卫。
 *
 * 补齐算法本身在 `historyWindowGap.test.ts` 有行为测试;这里锁住屏幕侧那几个"删掉也照样跑、
 * 但会悄悄踩坑"的前置条件 —— 它们各自对应一个具体故障:
 *  - 同步门槛用 lastSyncedAt 而不是 session+连接代 → 原地切会话时它仍是上一个会话的非空值,
 *    补齐基于旧缓存快照动手,而空洞 key 已记为已考察,那一处从此不再重试(#1210 review);
 *  - 不与「加载更早」/ 自身飞行互斥 → 两条 before 游标并发翻页,窗口反复 merge;
 *  - 飞行标记不带会话 id → 会话 A 的补齐挡掉 B 的;标记用 ref 而非 state → 清除时不触发重跑,
 *    B 的空洞在本次访问期间再也不被检测(#1210 review P1);
 *  - 每处空洞不去重、不设总闸 → messages 每变一次就重新发请求,一路往上翻整场历史;
 *  - 已考察集合不传给检测 → contiguous 结局不 merge、跳变留在窗口里,检测永远返回同一处,
 *    更早处的真实缺行进不了探测(#1210 review);
 *  - isCancelled 只比 effect 闭包里的 sessionId → 那个值恒等于启动时的值,等于没有取消;
 *  - 不检查锚点行是否还在窗口 → /clear、rewind 之后把刚被移除的历史 merge 回去。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('history window backfill wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

  it('同步门槛按 session + 连接代判定，不用屏幕级 lastSyncedAt', () => {
    expect(source).toContain('if (readAckSyncedKey !== `${sessionId}:${connectionEpoch}`) return;');
    expect(source).not.toContain('|| lastSyncedAt === null) return;');
  });

  it('与加载中/加载更早互斥，飞行标记带会话 id 且是可观察 state', () => {
    expect(source).toContain('if (loading || loadingEarlier || backfillInFlightSessionId === sessionId) return;');
    expect(source).toContain('const [backfillInFlightSessionId, setBackfillInFlightSessionId] = useState<string | null>(null);');
    // 收尾用函数式更新:切会话后新会话可能已起了自己那一轮,不能被旧的收尾误清。
    expect(source).toContain('setBackfillInFlightSessionId((current) => (current === sessionIdAtStart ? null : current));');
    expect(source).not.toContain('backfillInFlightRef');
  });

  it('已考察空洞按结局分三类：额度只算翻过页的，失败绑连接代，跳过表取并集', () => {
    // 额度只看 backfilled:正常停顿(contiguous)不该吃掉额度,否则几处隔夜间隔就能让更早的
    // 真实缺行永远排不到探测。
    expect(source).toContain('if (gapState.backfilled.size >= 3) return;');
    expect(source).toContain('findHistoryWindowGap(messages, consideredKeys)');
    expect(source).toContain('...gapState.contiguous,');
    expect(source).toContain('...gapState.backfilled,');
    expect(source).toContain('...gapState.failed,');
    // 断线那次不得把空洞永久钉死:换连接代只清 failed,重连后同一处可以再试。
    expect(source).toContain('gapState.failed.clear();');
    // 换会话时整体重置,否则上个会话的已考察集合会压住新会话的补齐。
    expect(source).toContain('existingState?.sid === sessionId');
  });

  it('结局归类在收尾而非发起前，且丢弃跨会话/跨连接代落地的旧结局', () => {
    expect(source).toContain("if (outcome === 'contiguous') state.contiguous.add(gapKey);");
    expect(source).toContain("else if (outcome === 'failed') state.failed.add(gapKey);");
    // cancelled 不记:会话切走后回来理应重新考察,锚点行被移除时那处跳变本身也不在了。
    expect(source).toContain("else if (outcome !== 'cancelled') state.backfilled.add(gapKey);");
    expect(source).toContain('state.sid !== sessionIdAtStart || state.epoch !== epochAtStart');
  });

  it('取消判定走会话镜像 ref 与锚点行是否仍在窗口，不是 effect 闭包里的 sessionId', () => {
    expect(source).toContain('backfillSessionRef.current = sessionId;');
    expect(source).toContain('isCancelled: () => backfillSessionRef.current !== sessionIdAtStart');
    expect(source).toContain('.some((row) => row.id === gap.newerId)');
  });

  it('补齐失败不写 error / loadingEarlier：它是静默自愈，不占用户可见的加载态', () => {
    const effectStart = source.indexOf('const backfillGapStateRef');
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
