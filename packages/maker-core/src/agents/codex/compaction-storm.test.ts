import { describe, it, expect } from 'vitest';
import {
  CompactionStormTracker,
  buildCompactionStormMessage,
  COMPACTION_STORM_MAX_INEFFECTIVE,
} from './compaction-storm.js';

/**
 * 实测数据 (rollout 019fcd52-6903, 2026-08-04): 切模型前一次正常压缩 241972 → 30738,
 * 切模型后连续 8 次压缩的压后水位几乎不动。用例直接拿这些数字当 fixture, 避免判据
 * 被改成"在合成数据上能过、在真实故障上不触发"。
 */
const STORM_POST_COMPACTION_TOKENS = [
  326503, 325868, 325922, 327909, 326767, 326827, 326952, 327383,
];

/** 走一遍「压缩边界 → 压后水位」序列, 返回每一步的判定。 */
function runSequence(
  tracker: CompactionStormTracker,
  tokens: readonly number[],
  startMs = 0,
  stepMs = 40_000,
): Array<ReturnType<CompactionStormTracker['noteUsage']>> {
  return tokens.map((t, i) => {
    tracker.noteCompaction();
    return tracker.noteUsage(t, startMs + i * stepMs);
  });
}

describe('CompactionStormTracker', () => {
  it('实测风暴序列会在连续无效次数达阈值时熔断', () => {
    const tracker = new CompactionStormTracker();
    const decisions = runSequence(tracker, STORM_POST_COMPACTION_TOKENS);

    // 第 1 条只建立基线, 不判定。
    expect(decisions[0]).toBeNull();
    // 之后每条都是无效压缩, 第 COMPACTION_STORM_MAX_INEFFECTIVE 次触发。
    const escalatedAt = decisions.findIndex((d) => d?.escalate);
    expect(escalatedAt).toBe(COMPACTION_STORM_MAX_INEFFECTIVE);
    expect(decisions[escalatedAt]?.ineffectiveCount).toBe(COMPACTION_STORM_MAX_INEFFECTIVE);
    expect(decisions[escalatedAt]?.contextTokens).toBe(STORM_POST_COMPACTION_TOKENS[escalatedAt]);
    // elapsedMs 从**首次**无效压缩起算, 不是从序列起点。
    expect(decisions[escalatedAt]?.elapsedMs).toBe(
      (COMPACTION_STORM_MAX_INEFFECTIVE - 1) * 40_000,
    );
  });

  it('压缩确实生效时不熔断 —— 正常长会话不会被误杀', () => {
    const tracker = new CompactionStormTracker();
    // 每次压缩都把水位打到 12% 左右 (实测正常压缩 241972 → 30738)。
    const decisions = runSequence(tracker, [241_972, 30_738, 210_000, 26_000, 190_000, 24_000]);
    expect(decisions.every((d) => !d?.escalate)).toBe(true);
  });

  it('中途一次有效压缩就清零连续计数', () => {
    const tracker = new CompactionStormTracker();
    // 无效 ×2 (差一次熔断) → 一次有效压缩清零 → 再无效 ×2。全程不该熔断。
    const decisions = runSequence(tracker, [326_000, 325_900, 326_100, 30_000, 320_000, 319_500]);
    expect(decisions.some((d) => d?.escalate)).toBe(false);
    expect(decisions[2]?.ineffectiveCount).toBe(2);
    expect(decisions[3]).toBeNull(); // 有效压缩不返回判定
    // 清零生效的判据: 若计数续着前面走, 这里会是 4 并且早已熔断。
    expect(decisions.at(-1)?.ineffectiveCount).toBe(2);
  });

  it('水位不降反涨同样算无效压缩', () => {
    const tracker = new CompactionStormTracker();
    const decisions = runSequence(tracker, [300_000, 310_000, 320_000, 330_000]);
    expect(decisions.at(-1)?.escalate).toBe(true);
  });

  it('不紧跟压缩边界的 usage 不参与判定', () => {
    const tracker = new CompactionStormTracker();
    tracker.noteCompaction();
    expect(tracker.noteUsage(326_000, 0)).toBeNull(); // 基线

    // turn 中途的常规 usage: 水位一路涨, 但没有压缩边界 —— 全部忽略,
    // 否则正常的上下文增长会被当成"压了没效果"。
    for (const t of [340_000, 360_000, 380_000]) {
      expect(tracker.noteUsage(t, 1_000)).toBeNull();
    }

    tracker.noteCompaction();
    const d = tracker.noteUsage(325_900, 40_000);
    // 比较对象是**上一次压缩后**的 326000, 不是中途那些 380000。
    expect(d?.ineffectiveCount).toBe(1);
    expect(d?.escalate).toBe(false);
  });

  it('跨 turn 的连续压缩照常累计 —— 病因是会话级的', () => {
    const tracker = new CompactionStormTracker();
    // 实测那 8 次压缩跨了两个 turn; tracker 不按 turn 记账, 所以不会被拆成两段。
    const decisions = runSequence(tracker, STORM_POST_COMPACTION_TOKENS.slice(0, 4));
    expect(decisions.at(-1)?.escalate).toBe(true);
  });

  it('reset 后重新计数 (用户发新消息)', () => {
    const tracker = new CompactionStormTracker();
    runSequence(tracker, STORM_POST_COMPACTION_TOKENS.slice(0, 4));
    tracker.reset();

    const decisions = runSequence(tracker, STORM_POST_COMPACTION_TOKENS.slice(0, 3));
    // reset 抹掉了基线, 所以第一条重新成为基线, 三条只累计到 2 次, 够不到阈值。
    expect(decisions[0]).toBeNull();
    expect(decisions.some((d) => d?.escalate)).toBe(false);
  });

  it('无效或非正的 token 数不参与判定', () => {
    const tracker = new CompactionStormTracker();
    tracker.noteCompaction();
    expect(tracker.noteUsage(0, 0)).toBeNull();
    expect(tracker.noteUsage(Number.NaN, 0)).toBeNull();
  });
});

describe('buildCompactionStormMessage', () => {
  it('切过模型时点名两个模型与可操作出路', () => {
    const msg = buildCompactionStormMessage({
      ineffectiveCount: 3,
      contextTokens: 326_827,
      elapsedMs: 120_000,
      switchedModel: { from: 'codex/gpt-5.6-sol', to: 'claude-opus-5' },
    });
    expect(msg).toContain('codex/gpt-5.6-sol');
    expect(msg).toContain('claude-opus-5');
    expect(msg).toContain('326827');
    expect(msg).toContain('start a new task');
  });

  it('没有切模型记录时不猜原因', () => {
    const msg = buildCompactionStormMessage({
      ineffectiveCount: 3,
      contextTokens: 326_827,
      elapsedMs: 120_000,
      switchedModel: null,
    });
    expect(msg).not.toContain('switched model');
    expect(msg).toContain('system prompt and tool definitions');
  });
});
