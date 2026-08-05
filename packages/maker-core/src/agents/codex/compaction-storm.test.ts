import { describe, it, expect } from 'vitest';
import {
  CompactionStormTracker,
  buildCompactionStormTerminalError,
  COMPACTION_STORM_MAX_INEFFECTIVE,
  COMPACTION_STORM_MAX_SKIPPED_USAGE,
  COMPACTION_STORM_REASON,
  COMPACTION_STORM_REASON_MODEL_SWITCH,
} from './compaction-storm.js';

/**
 * 所有 fixture 取自 rollout 019fcd52-6903 (2026-08-04) 的真实事件序列。
 *
 * 实测每一轮压缩都长这样 —— **压缩边界后紧跟一条 `last.inputTokens = 0`**
 * (压缩完成标记, 15:28 那次连发两条), 之后才是压缩后第一个正常请求的水位:
 *   usage(pre) → contextCompaction → usage(0)[×1~2] → usage(post)
 * 用例必须把那些 0 一起喂进去, 否则测的是一个现实里不存在的时序。
 */
type Step =
  | { kind: 'usage'; tokens: number }
  | { kind: 'compaction' };

const u = (tokens: number): Step => ({ kind: 'usage', tokens });
const compact = (): Step => ({ kind: 'compaction' });

/** 实测正常压缩: pre=241972 → post=30738 (降到 12.7%)。 */
const HEALTHY_COMPACTION: Step[] = [
  u(236_640), u(241_972), compact(), u(0), u(30_738), u(41_455),
];

/**
 * 实测风暴的前四轮 (15:24:52 / 15:25:36 / 15:26:08 / 15:28:35)。
 * 每轮 pre 只有 30k 上下(历史已被压到底), post 却仍是 326k(system prompt +
 * MCP 工具定义撑着) —— 压缩碰不到那部分, 所以压了等于没压。
 */
const STORM_ROUNDS: Step[] = [
  u(470_586), u(176_539), compact(), u(0), u(326_503), u(326_503),
  u(32_283), compact(), u(0), u(325_868), u(325_868),
  u(30_544), compact(), u(0), u(325_922), u(325_922),
  u(30_513), compact(), u(0), u(0), u(327_909),
];

/** 按步骤喂给 tracker, 返回每一步的判定 (usage 步才有)。 */
function run(
  tracker: CompactionStormTracker,
  steps: readonly Step[],
  startMs = 0,
  stepMs = 10_000,
): Array<ReturnType<CompactionStormTracker['noteUsage']>> {
  const out: Array<ReturnType<CompactionStormTracker['noteUsage']>> = [];
  steps.forEach((s, i) => {
    if (s.kind === 'compaction') tracker.noteCompaction();
    else out.push(tracker.noteUsage(s.tokens, startMs + i * stepMs));
  });
  return out;
}

describe('CompactionStormTracker', () => {
  it('实测风暴序列会熔断(含压缩后紧跟的 0 标记)', () => {
    const tracker = new CompactionStormTracker();
    const decisions = run(tracker, STORM_ROUNDS);
    const escalated = decisions.filter((d) => d?.escalate);
    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated[0]?.ineffectiveCount).toBe(COMPACTION_STORM_MAX_INEFFECTIVE);
    // pre 与 post 都要如实带出来供诊断: 30k 的历史压出 326k 的总量。
    expect(escalated[0]?.preCompactionTokens).toBeLessThan(50_000);
    expect(escalated[0]?.contextTokens).toBeGreaterThan(300_000);
  });

  // 回归 (2026-08-05): 压缩后那条 0 若被当成"压缩后水位", 判据永远读不到真实 post,
  // 熔断彻底失效。这条用例专门钉住"跳过 0、继续找 post"这个语义。
  it('压缩后紧跟的 0 不会被当成压缩后水位', () => {
    const tracker = new CompactionStormTracker();
    // 单轮: pre=32283 → 0 → post=325868, 必须判成一次无效压缩。
    const decisions = run(tracker, [
      u(326_503), u(32_283), compact(), u(0), u(325_868),
    ]);
    const judged = decisions.filter((d) => d !== null);
    expect(judged).toHaveLength(1);
    expect(judged[0]?.ineffectiveCount).toBe(1);
    expect(judged[0]?.preCompactionTokens).toBe(32_283);
    expect(judged[0]?.contextTokens).toBe(325_868);
  });

  it('连发两条 0 也照样找到 post', () => {
    const tracker = new CompactionStormTracker();
    const decisions = run(tracker, [
      u(325_922), u(30_513), compact(), u(0), u(0), u(327_909),
    ]);
    expect(decisions.filter((d) => d !== null)).toHaveLength(1);
  });

  it('非正值超过上限后放弃这次边界, 不让后续普通 usage 冒名顶替', () => {
    const tracker = new CompactionStormTracker();
    const zeros: Step[] = Array.from(
      { length: COMPACTION_STORM_MAX_SKIPPED_USAGE + 1 },
      () => u(0),
    );
    const decisions = run(tracker, [
      u(200_000), compact(), ...zeros,
      // 边界已被放弃, 这两条只是普通 usage —— 不该产生任何判定。
      u(320_000),
      u(330_000),
    ]);
    expect(decisions.every((d) => d === null)).toBe(true);
  });

  // Codex review 提的核心误杀场景。
  it('长 turn 里多次有效压缩、每次回到相近 floor —— 不熔断', () => {
    const tracker = new CompactionStormTracker();
    // 一个健康的 autonomous turn: 上下文涨到 ~200k 就压一次, 每次都压回 30k 上下。
    // floor 之间**不单调下降**(30k → 31k → 29k → 32k), 这正是正常压缩的样子。
    const steps: Step[] = [];
    for (const [pre, post] of [
      [210_000, 30_000],
      [205_000, 31_000],
      [198_000, 29_000],
      [212_000, 32_000],
      [207_000, 30_500],
    ] as const) {
      steps.push(u(pre), compact(), u(0), u(post));
    }
    const decisions = run(tracker, steps);
    expect(decisions.some((d) => d?.escalate)).toBe(false);
    // 每一次都判为有效压缩, 一次无效都不该记。
    expect(decisions.every((d) => d === null)).toBe(true);
  });

  it('实测正常压缩不熔断', () => {
    const tracker = new CompactionStormTracker();
    const decisions = run(tracker, HEALTHY_COMPACTION);
    expect(decisions.every((d) => d === null)).toBe(true);
  });

  it('中途一次有效压缩就清零连续计数', () => {
    const tracker = new CompactionStormTracker();
    const steps: Step[] = [
      u(30_000), compact(), u(0), u(326_000), // 无效 #1
      u(30_100), compact(), u(0), u(326_100), // 无效 #2 (差一次熔断)
      u(200_000), compact(), u(0), u(30_000), // 有效 → 清零
      u(30_200), compact(), u(0), u(325_000), // 无效 #1 (重新计)
      u(30_300), compact(), u(0), u(325_500), // 无效 #2
    ];
    const decisions = run(tracker, steps);
    expect(decisions.some((d) => d?.escalate)).toBe(false);
    const judged = decisions.filter((d) => d !== null);
    // 清零生效的判据: 若计数续着前面走, 最后一条会是 4 且早已熔断。
    expect(judged.at(-1)?.ineffectiveCount).toBe(2);
  });

  it('水位不降反涨算无效压缩', () => {
    const tracker = new CompactionStormTracker();
    const decisions = run(tracker, [
      u(300_000), compact(), u(0), u(310_000),
      u(310_000), compact(), u(0), u(320_000),
      u(320_000), compact(), u(0), u(330_000),
    ]);
    expect(decisions.at(-1)?.escalate).toBe(true);
  });

  it('turn 中途的常规 usage 不参与判定, 只更新 pre 候选', () => {
    const tracker = new CompactionStormTracker();
    // 没有压缩边界时, 水位一路涨也不该判定。
    const decisions = run(tracker, [u(120_000), u(180_000), u(240_000)]);
    expect(decisions.every((d) => d === null)).toBe(true);

    // 压缩用的 pre 是紧邻边界的那条 240000 —— post 回到 30k, 判有效。
    const after = run(tracker, [compact(), u(0), u(30_000)], 100_000);
    expect(after.every((d) => d === null)).toBe(true);
  });

  it('跨 turn 的连续压缩照常累计 —— 病因是会话级的', () => {
    const tracker = new CompactionStormTracker();
    // 实测那 8 次压缩跨了两个 turn; tracker 不按 turn 记账, 不会被拆成两段。
    const decisions = run(tracker, STORM_ROUNDS);
    expect(decisions.some((d) => d?.escalate)).toBe(true);
  });

  it('reset 后重新计数 (用户发新消息)', () => {
    const tracker = new CompactionStormTracker();
    run(tracker, STORM_ROUNDS);
    tracker.reset();

    // reset 抹掉了 pre 基线, 第一轮只能重新建立, 够不到阈值。
    const decisions = run(tracker, [
      u(30_000), compact(), u(0), u(326_000),
      u(30_100), compact(), u(0), u(326_100),
    ]);
    expect(decisions.some((d) => d?.escalate)).toBe(false);
  });

  it('会话刚起就压缩 (没有 pre) 时只建基线, 不判定', () => {
    const tracker = new CompactionStormTracker();
    const decisions = run(tracker, [compact(), u(0), u(326_000)]);
    expect(decisions.every((d) => d === null)).toBe(true);
  });

  it('无效或非正的 token 数不参与判定', () => {
    const tracker = new CompactionStormTracker();
    expect(tracker.noteUsage(0, 0)).toBeNull();
    expect(tracker.noteUsage(Number.NaN, 0)).toBeNull();
  });

  // Greptile 提出「last 可能是增量而非绝对水位」。用真实 payload 固定语义:
  // total 与 last **不相等**(total 是 last 的累加), 判据必须吃 last。
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

    // 喂 last: 实测风暴熔断、实测正常压缩不熔断。
    expect(run(new CompactionStormTracker(), STORM_ROUNDS).some((d) => d?.escalate)).toBe(true);
    expect(run(new CompactionStormTracker(), HEALTHY_COMPACTION).every((d) => d === null)).toBe(
      true,
    );

    // 喂 total(单调累加)则 post 永远远大于 pre, 正常压缩也会被判成无效 ——
    // 说明这个字段根本不承载"压缩效果"信息, 字段选择本身是有判别力的。
    let acc = 0;
    const healthyAsTotal: Step[] = HEALTHY_COMPACTION.map((s) => {
      if (s.kind === 'compaction') return s;
      acc += s.tokens;
      return u(acc);
    });
    const repeated = [...healthyAsTotal, ...healthyAsTotal, ...healthyAsTotal];
    expect(run(new CompactionStormTracker(), repeated).some((d) => d?.escalate)).toBe(true);
  });
});

describe('buildCompactionStormTerminalError', () => {
  it('切过模型时点名两个模型与可操作出路, 并用切模型专用 reason', () => {
    const { reason, message } = buildCompactionStormTerminalError({
      ineffectiveCount: 3,
      contextTokens: 326_827,
      elapsedMs: 120_000,
      switchedModel: { from: 'codex/gpt-5.6-sol', to: 'claude-opus-5' },
    });
    expect(reason).toBe(COMPACTION_STORM_REASON_MODEL_SWITCH);
    expect(message).toContain('codex/gpt-5.6-sol');
    expect(message).toContain('claude-opus-5');
    expect(message).toContain('326827');
    expect(message).toContain('start a new task');
    // 首句必须是通顺的英文 —— 它是非 renderer 消费方(IM / orca / 日志)唯一看到的
    // 说明, 断言整句而不是零散关键词, 免得语法退化没人发现。
    expect(message).toContain(
      '3 compactions over 120s, each leaving about 326827 input tokens behind, ' +
      'so compaction cannot recover this turn.',
    );
  });

  // 回归 (Codex review): renderer 用 reason 的本地化文案**覆盖** message, 所以没有
  // 切换证据时必须换 reason —— 只改 message 是没用的, 用户看到的仍是 reason 那条。
  it('没有切模型记录时用通用 reason, 且不猜原因', () => {
    const { reason, message } = buildCompactionStormTerminalError({
      ineffectiveCount: 3,
      contextTokens: 326_827,
      elapsedMs: 120_000,
      switchedModel: null,
    });
    expect(reason).toBe(COMPACTION_STORM_REASON);
    expect(reason).not.toBe(COMPACTION_STORM_REASON_MODEL_SWITCH);
    expect(message).not.toContain('switched model');
    expect(message).not.toContain('Switch back');
    expect(message).toContain('system prompt and tool definitions');
  });

  it('两个 reason 必须不同 —— 否则本地化文案无从区分证据', () => {
    expect(COMPACTION_STORM_REASON).not.toBe(COMPACTION_STORM_REASON_MODEL_SWITCH);
  });

  // reason 与 message 同源: 结构上不可能出现"reason 说因为切模型、message 说不知道
  // 原因"这种分叉 —— 而分叉后错的那半恰好是用户唯一看得到的那半。
  it('reason 与 message 永远一致地反映有没有切换证据', () => {
    for (const switchedModel of [null, { from: 'a', to: 'b' }] as const) {
      const { reason, message } = buildCompactionStormTerminalError({
        ineffectiveCount: 3,
        contextTokens: 1_000,
        elapsedMs: 1_000,
        switchedModel,
      });
      const reasonClaimsSwitch = reason === COMPACTION_STORM_REASON_MODEL_SWITCH;
      const messageClaimsSwitch = message.includes('switched model');
      expect(reasonClaimsSwitch).toBe(messageClaimsSwitch);
      expect(reasonClaimsSwitch).toBe(switchedModel !== null);
    }
  });
});
