/**
 * 空洞补齐在会话屏幕上的接线守卫。
 *
 * 补齐算法本身在 `historyWindowGap.test.ts` 有行为测试;这里锁住屏幕侧那些"删掉也照样跑、但会
 * 悄悄踩坑"的前置条件。#1210 的三轮 review 全部集中在这一层,所以先把不变量写清,再逐条对着断言
 * ——每条不变量在代码里只允许有**一个**判据,所有对称路径复用它:
 *
 * 1. **一轮补齐的身份是单调的**:每次启动分配只增不减的 `runSeq`;"是否已被取代"、飞行标记的
 *    清除、结论的写入,全都对着 seq 比。凡是"当前状态是否仍等于启动时状态"的判据都不可靠 ——
 *    会话 id 会摆回来(A 在飞 → 切到 B → 快速切回 A),那种判据会把取消**撤销**掉,于是同一会话
 *    并发翻页、旧轮收尾还误清新轮的标记,越滚越多。
 * 2. **同一会话同一时刻最多一轮在飞**:互斥按 `inFlight.sid === sessionId`;别的会话残留的那一轮
 *    不连坐当前会话(它自己会在下一次 isCancelled 上收手)。
 * 3. **同步门槛按 session + 连接代判定**:屏实例会被原地复用,屏幕级 `lastSyncedAt` 在切会话后
 *    仍是上一个会话的非空值,补齐会基于旧缓存快照动手。
 * 4. **每个结局有独立的遗忘条件与预算归属**:contiguous(事实,永久跳过,不占翻页额度)/
 *    backfilled(真翻过页,占翻页额度)/ failed(绑 connectionEpoch,重连后可重试)/ cancelled(不记)。
 * 5. **两道预算闸**:考察总次数(防海量正常停顿打出上百次探测)、翻页段数(防一路翻整场历史)。
 * 6. **补齐永不写用户可见的加载态或错误**:它是静默自愈,失败由渲染层的空洞守卫兜底。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('history window backfill wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

  it('不变量 1：一轮的身份是单调 seq，取消不可撤销', () => {
    expect(source).toContain('const runSeq = backfillRunSeqRef.current + 1;');
    expect(source).toContain('backfillLatestRunSeqRef.current = runSeq;');
    // 取消判据对着 seq 比,不是"当前会话 id 是否仍等于启动时的"——后者会随切回来而摆回。
    expect(source).toContain('isCancelled: () => backfillLatestRunSeqRef.current !== runSeq');
    // 结论写入同样要求"我还是最新那一轮"。
    expect(source).toContain('if (backfillLatestRunSeqRef.current !== runSeq) return;');
    // 收尾按 seq 精确清标记:按 sid 比会把切回同一会话后新起那一轮的标记误清。
    expect(source).toContain('setBackfillInFlightRun((current) => (current?.seq === runSeq ? null : current));');
    // 切会话、或用户手动开始「加载更早」时占掉一个序号作废在飞的那一轮(单向,不启动新轮)。
    // loadingEarlier 必须在依赖里:启动前守卫只挡"手动先开始",挡不住"自动先开始、用户随后点"。
    expect(source).toContain('backfillRunSeqRef.current += 1;');
    expect(source).toContain('}, [sessionId, loadingEarlier]);');
    // 已退役的可摆动判据不得回归。
    expect(source).not.toContain('backfillSessionRef');
    expect(source).not.toContain('backfillInFlightRef');
  });

  it('不变量 2：互斥只挡同一会话，且飞行标记是可观察 state', () => {
    expect(source).toContain('if (loading || loadingEarlier || backfillInFlightRun?.sid === sessionId) return;');
    expect(source).toContain('const [backfillInFlightRun, setBackfillInFlightRun] = useState<{ sid: string; seq: number } | null>(null);');
  });

  it('不变量 3：同步门槛按 session + 连接代，不用屏幕级 lastSyncedAt', () => {
    expect(source).toContain('if (readAckSyncedKey !== `${sessionId}:${connectionEpoch}`) return;');
    expect(source).not.toContain('|| lastSyncedAt === null) return;');
  });

  it('不变量 4：结局分三类，失败绑连接代，cancelled 不记，跳过表取并集', () => {
    expect(source).toContain("if (outcome === 'contiguous') state.contiguous.add(gapKey);");
    expect(source).toContain("else if (outcome === 'failed') state.failed.add(gapKey);");
    expect(source).toContain("else if (outcome !== 'cancelled') state.backfilled.add(gapKey);");
    // 断线那次不得把空洞永久钉死:换连接代只清 failed,重连后同一处可以再试。
    expect(source).toContain('gapState.failed.clear();');
    // 换会话时整体重置,否则上个会话的已考察集合会压住新会话的补齐。
    expect(source).toContain('existingState?.sid === sessionId');
    expect(source).toContain('state.sid !== sessionIdAtStart || state.epoch !== epochAtStart');
    expect(source).toContain('findHistoryWindowGap(messages, consideredKeys)');
    expect(source).toContain('...gapState.contiguous,');
    expect(source).toContain('...gapState.backfilled,');
    expect(source).toContain('...gapState.failed,');
  });

  it('不变量 5：两道预算闸都在，且额度只算翻过页的', () => {
    expect(source).toContain('if (gapState.backfilled.size >= HISTORY_BACKFILL_MAX_GAPS_PER_VISIT) return;');
    expect(source).toContain('if (consideredKeys.size >= HISTORY_GAP_MAX_CONSIDERED_PER_VISIT) return;');
    // 硬编码的 3 不得回归:两道闸的语义与理由写在常量注释里。
    expect(source).not.toContain('.backfilled.size >= 3');
  });

  it('不变量 6：补齐不写 error / loadingEarlier，锚点行消失即收手', () => {
    expect(source).toContain('.some((row) => row.id === gap.newerId)');
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
