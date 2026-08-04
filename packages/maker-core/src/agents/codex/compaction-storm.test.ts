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

  // 回归: 压缩边界后的第一条 usage 即使数字不可用, 也已经"用掉"了这次机会。
  // 若 awaitingUsage 留着, 紧随其后的普通 usage(turn 中途累积的水位)会被冒名顶替
  // 成压缩后水位 —— 既可能凭空熔断, 也可能把真正的压后水位挤掉而漏判。
  it('无效 usage 消费掉压缩边界后, 后续普通 usage 不再被当成压后水位', () => {
    const tracker = new CompactionStormTracker();

    tracker.noteCompaction();
    expect(tracker.noteUsage(Number.NaN, 0)).toBeNull(); // 无效, 但消费掉这次边界

    // 没有新的压缩边界 —— 这些普通 usage 必须被完全忽略, 不能建立基线。
    expect(tracker.noteUsage(120_000, 1_000)).toBeNull();
    expect(tracker.noteUsage(240_000, 2_000)).toBeNull();

    // 下一次真正的压缩边界才重新开始: 这条只建立基线, 不判定。
    tracker.noteCompaction();
    expect(tracker.noteUsage(326_503, 40_000)).toBeNull();

    tracker.noteCompaction();
    const d = tracker.noteUsage(325_868, 80_000);
    // 比较对象是上一次压缩后的 326503, 而不是中途那些 120000 / 240000。
    expect(d?.ineffectiveCount).toBe(1);
    expect(d?.escalate).toBe(false);
  });

  // Greptile 提出「last 可能是增量而非绝对水位」。用 rollout 019fcd52 的真实 payload
  // 固定语义: total 与 last **不相等**(total 是 last 的累加), 判据必须吃 last。
  // 证据见 noteUsage 的注释: total[n]-total[n-1] === last[n], 且 cached[n] ≈ last[n-1]。
  it('吃 last.inputTokens(单次请求的完整 prompt)才判得对; 喂 total 会失效', () => {
    // 真实相邻样本: (last, cached, total) —— total 明显是累加值, 与 last 不同量级。
    const REAL = [
      { last: 28_610, cached: 3_712, total: 28_610 },
      { last: 39_722, cached: 28_288, total: 68_332 },
      { last: 42_895, cached: 39_552, total: 111_227 },
      { last: 54_840, cached: 42_624, total: 166_067 },
    ];
    // total 是 last 的累加 —— 这条恒等式正是"last 是单次请求量"的证据。
    for (let i = 1; i < REAL.length; i += 1) {
      expect(REAL[i].total - REAL[i - 1].total).toBe(REAL[i].last);
    }
    // 本次 prompt 的前一大段命中上次请求建立的 cache, 说明 last 是完整 prompt 量,
    // 而不是"比上次多出来的部分"。
    for (let i = 1; i < REAL.length; i += 1) {
      expect(REAL[i].cached).toBeLessThanOrEqual(REAL[i - 1].last);
      expect(REAL[i].cached).toBeGreaterThan(REAL[i - 1].last * 0.95);
    }

    // 喂 last: 实测风暴序列正常熔断。
    const onLast = new CompactionStormTracker();
    expect(runSequence(onLast, STORM_POST_COMPACTION_TOKENS).some((d) => d?.escalate)).toBe(true);

    // 喂 total(单调累加)则永远"在增长", 每次都判无效 —— 但会把正常压缩也判成无效,
    // 也就是说这个字段根本不承载"压缩效果"信息。用实测的正常压缩序列证明这一点:
    // 同一批数据下 last 口径不熔断, total 口径却会熔断。
    const healthyLast = [241_972, 30_738, 210_000, 26_000, 190_000, 24_000];
    const healthyTotal: number[] = [];
    healthyLast.reduce((acc, v) => {
      healthyTotal.push(acc + v);
      return acc + v;
    }, 0);

    const onHealthyLast = new CompactionStormTracker();
    expect(runSequence(onHealthyLast, healthyLast).some((d) => d?.escalate)).toBe(false);

    const onHealthyTotal = new CompactionStormTracker();
    expect(runSequence(onHealthyTotal, healthyTotal).some((d) => d?.escalate)).toBe(true);
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
    // 首句必须是通顺的英文 —— 它是非 renderer 消费方(IM / orca / 日志)唯一看到的
    // 说明, 断言整句而不是零散关键词, 免得语法退化没人发现。
    expect(msg).toContain(
      '3 compactions over 120s, each leaving about 326827 input tokens behind, ' +
      'so compaction cannot recover this turn.',
    );
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
