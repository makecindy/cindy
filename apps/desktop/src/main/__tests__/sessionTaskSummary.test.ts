/**
 * sessionTaskSummary.logic 单测 —— 覆盖摘要管线的可测纯逻辑(PR #127 review 必改:
 * main 摘要管线缺回归测试)。运行时副作用(DB / oneShot / broadcast)留在
 * sessionTaskSummary.ts;这里锁住档位选择 / sanitize 截断 / 定时识别 / 素材判定 /
 * 内容抽取这些后续最容易被改坏、而 typecheck·db-validate 覆盖不到的判定。
 */
import { describe, it, expect } from 'vitest';
import {
  STALE_DEMOTE_MS,
  STALE_SHORT_MS,
  SUMMARY_MAX_CHARS,
  SUMMARY_SHORT_MAX_CHARS,
  SUMMARY_STALE_MAX_CHARS,
  TIER_SHORT_MAX_MESSAGES,
  TIER_LONG_MIN_MESSAGES,
  extractText,
  sanitize,
  isScheduledSession,
  pickTier,
  maxCharsForTier,
  hasSummarizableMaterial,
  shouldGeneratePinnedCardSummary,
  shouldVoidSummaryAfterGenerationAttempt,
  nonCardTurnDisplayPatch,
  shouldForceGenerateOnClear,
  shouldScheduleForceGenerateAfterInFlight,
} from '../sessionTaskSummary.logic';

describe('pickTier — 距今时间为主轴的档位选择', () => {
  const recent = 60 * 60 * 1000; // 1h，属 <24h 近期

  it('距今 ≥3 天 → stale,且优先级高于消息数/定时', () => {
    expect(pickTier({ inactiveMs: STALE_SHORT_MS, messageCount: 9999, isScheduled: true })).toBe(
      'stale',
    );
    expect(pickTier({ inactiveMs: STALE_SHORT_MS + 1, messageCount: 0, isScheduled: false })).toBe(
      'stale',
    );
  });

  it('距今 24h~3 天 → short', () => {
    expect(pickTier({ inactiveMs: STALE_DEMOTE_MS, messageCount: 500, isScheduled: false })).toBe(
      'short',
    );
    expect(
      pickTier({ inactiveMs: STALE_SHORT_MS - 1, messageCount: 500, isScheduled: false }),
    ).toBe('short');
  });

  it('近期 + 定时任务 → short(早于消息数判定)', () => {
    expect(pickTier({ inactiveMs: recent, messageCount: 9999, isScheduled: true })).toBe('short');
  });

  it('近期 + 重上下文(≥200 条)→ long', () => {
    expect(
      pickTier({ inactiveMs: recent, messageCount: TIER_LONG_MIN_MESSAGES, isScheduled: false }),
    ).toBe('long');
  });

  it('近期 + 轻量(≤60 条)→ short', () => {
    expect(
      pickTier({ inactiveMs: recent, messageCount: TIER_SHORT_MAX_MESSAGES, isScheduled: false }),
    ).toBe('short');
    expect(pickTier({ inactiveMs: recent, messageCount: 0, isScheduled: false })).toBe('short');
  });

  it('近期 + 中间量(60<n<200)→ auto', () => {
    expect(pickTier({ inactiveMs: recent, messageCount: 61, isScheduled: false })).toBe('auto');
    expect(pickTier({ inactiveMs: recent, messageCount: 199, isScheduled: false })).toBe('auto');
  });
});

describe('maxCharsForTier', () => {
  it('各档位 → 对应硬上限', () => {
    expect(maxCharsForTier('stale')).toBe(SUMMARY_STALE_MAX_CHARS);
    expect(maxCharsForTier('short')).toBe(SUMMARY_SHORT_MAX_CHARS);
    expect(maxCharsForTier('long')).toBe(SUMMARY_MAX_CHARS);
    expect(maxCharsForTier('auto')).toBe(SUMMARY_MAX_CHARS);
  });
});

describe('isScheduledSession — 对齐 renderer isAutomationGeneratedSession', () => {
  it('source=scheduler → true', () => {
    expect(isScheduledSession('scheduler', '随便什么标题')).toBe(true);
  });
  it('旧数据标题前缀 [Schedule]  → true', () => {
    expect(isScheduledSession(null, '[Schedule] 每日巡检')).toBe(true);
    expect(isScheduledSession('desktop', '[Schedule] 每日巡检')).toBe(true);
  });
  it('普通会话 → false', () => {
    expect(isScheduledSession(null, '重构 Prompt')).toBe(false);
    expect(isScheduledSession(undefined, '日报 [Schedule] 不在开头')).toBe(false);
  });
});

describe('hasSummarizableMaterial — 空草稿跳过', () => {
  it('user/assistant 皆空 → false', () => {
    expect(hasSummarizableMaterial('', '')).toBe(false);
  });
  it('任一非空 → true', () => {
    expect(hasSummarizableMaterial('做点啥', '')).toBe(true);
    expect(hasSummarizableMaterial('', '已完成')).toBe(true);
  });
});

describe('shouldGeneratePinnedCardSummary', () => {
  it('只在置顶 + 活跃 + 卡片模式时生成', () => {
    expect(
      shouldGeneratePinnedCardSummary({
        status: 'active',
        pinnedAt: 1,
        pinnedSectionIsCard: true,
      }),
    ).toBe(true);
    expect(
      shouldGeneratePinnedCardSummary({
        status: 'active',
        pinnedAt: 1,
        pinnedSectionIsCard: false,
      }),
    ).toBe(false);
    expect(
      shouldGeneratePinnedCardSummary({
        status: 'active',
        pinnedAt: null,
        pinnedSectionIsCard: true,
      }),
    ).toBe(false);
    expect(
      shouldGeneratePinnedCardSummary({
        status: 'archived',
        pinnedAt: 1,
        pinnedSectionIsCard: true,
      }),
    ).toBe(false);
  });
});

describe('shouldVoidSummaryAfterGenerationAttempt', () => {
  it('成功写回则留下,即使随后切出卡片', () => {
    expect(
      shouldVoidSummaryAfterGenerationAttempt({
        wroteFresh: true,
        pinnedSectionIsCard: false,
      }),
    ).toBe(false);
  });
  it('仍在卡片模式则不因失败作废', () => {
    expect(
      shouldVoidSummaryAfterGenerationAttempt({
        wroteFresh: false,
        pinnedSectionIsCard: true,
      }),
    ).toBe(false);
  });
  it('未写回且已切出卡片 → 作废旧句子', () => {
    expect(
      shouldVoidSummaryAfterGenerationAttempt({
        wroteFresh: false,
        pinnedSectionIsCard: false,
      }),
    ).toBe(true);
  });
});

describe('shouldForceGenerateOnClear', () => {
  it('切回卡片且没有生成在飞 → 可以 force 再生成', () => {
    expect(
      shouldForceGenerateOnClear({
        pinnedSectionIsCard: true,
        sessionGenerateInFlight: false,
      }),
    ).toBe(true);
  });
  it('仍在列表 → 不生成', () => {
    expect(
      shouldForceGenerateOnClear({
        pinnedSectionIsCard: false,
        sessionGenerateInFlight: false,
      }),
    ).toBe(false);
  });
  it('生成尚未 settle 时不得再入,否则 await 同一条 inFlight 死锁', () => {
    expect(
      shouldForceGenerateOnClear({
        pinnedSectionIsCard: true,
        sessionGenerateInFlight: true,
      }),
    ).toBe(false);
  });
});

describe('shouldScheduleForceGenerateAfterInFlight', () => {
  it('切回卡片且生成仍在飞 → 结算后再 force,不在当前栈 await', () => {
    expect(
      shouldScheduleForceGenerateAfterInFlight({
        pinnedSectionIsCard: true,
        sessionGenerateInFlight: true,
      }),
    ).toBe(true);
  });
  it('空闲或仍在列表 → 不预约', () => {
    expect(
      shouldScheduleForceGenerateAfterInFlight({
        pinnedSectionIsCard: true,
        sessionGenerateInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldScheduleForceGenerateAfterInFlight({
        pinnedSectionIsCard: false,
        sessionGenerateInFlight: true,
      }),
    ).toBe(false);
  });
});

describe('nonCardTurnDisplayPatch', () => {
  it('列表结算必须同时清摘要并带上最新 preview', () => {
    expect(nonCardTurnDisplayPatch('刚完成的回复')).toEqual({
      summary: null,
      preview: '刚完成的回复',
    });
    expect(nonCardTurnDisplayPatch(null)).toEqual({
      summary: null,
      preview: null,
    });
  });
});

describe('sanitize — 去噪 + 句界截断', () => {
  it('短文本原样(去引号/折叠空白)', () => {
    expect(sanitize('"生成海报。"', SUMMARY_MAX_CHARS)).toBe('生成海报。');
    expect(sanitize('「任务」', SUMMARY_MAX_CHARS)).toBe('任务');
    expect(sanitize('a   b\n c', SUMMARY_MAX_CHARS)).toBe('a b c');
  });

  it('超长 → 截到上限内最后一个句末标点(≥3/4 上限)', () => {
    // maxChars=26, minKeep=19;句号落在 index 19(达 minKeep)→ 保留到句号
    const text = 'a'.repeat(19) + '。' + 'b'.repeat(20);
    expect(sanitize(text, SUMMARY_MAX_CHARS)).toBe('a'.repeat(19) + '。');
  });

  it('无句末标点 → 退到最后一个子句边界并补句号', () => {
    const text = 'a'.repeat(19) + '，' + 'b'.repeat(20);
    expect(sanitize(text, SUMMARY_MAX_CHARS)).toBe('a'.repeat(19) + '。');
  });

  it('上限内无可用边界(标点太靠前)→ 硬截到上限(原样保留前 N 字,不把早标点当截断点)', () => {
    // 句号在 index 10 < minKeep(19):不作为句界截断点 → 直接硬截前 26 字(含那个早句号)
    const text = 'a'.repeat(10) + '。' + 'a'.repeat(30);
    const out = sanitize(text, SUMMARY_MAX_CHARS);
    expect(out).toBe(text.slice(0, SUMMARY_MAX_CHARS));
    expect(out.length).toBe(SUMMARY_MAX_CHARS);
  });

  it('短档上限(16)同样硬收敛,保证回填不反复重生成', () => {
    expect(sanitize('x'.repeat(40), SUMMARY_SHORT_MAX_CHARS).length).toBe(SUMMARY_SHORT_MAX_CHARS);
  });
});

describe('extractText — messages.content JSON → 纯文本', () => {
  it('user 消息取 .text 字段', () => {
    expect(extractText(JSON.stringify({ text: '帮我画图' }), 'user')).toBe('帮我画图');
  });
  it('assistant 消息为 JSON 字符串 → 原样', () => {
    expect(extractText(JSON.stringify('已经画好了'), 'assistant')).toBe('已经画好了');
  });
  it('非法 JSON → 退回原始字符串', () => {
    expect(extractText('not-json', 'assistant')).toBe('not-json');
  });
  it('空/缺失 → 空串', () => {
    expect(extractText(null, 'user')).toBe('');
    expect(extractText(undefined, 'assistant')).toBe('');
    expect(extractText(JSON.stringify({ noText: 1 }), 'user')).toBe('');
  });

  it('标题素材使用 semantic projection，保留 raw wire 但不暴露 quote marker / 私有深链', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const raw = JSON.stringify({
      text,
      quotesEncoded: true,
      agentReferences: [
        {
          kind: 'message',
          start: text.indexOf(href),
          end: text.indexOf(href) + href.length,
          href,
          sessionId: 'session-a',
          messageClientId: 'message-a',
          text: 'Target message body',
        },
      ],
    });

    const projected = extractText(raw, 'user');
    expect(projected).not.toContain('cindy-composer-quote');
    expect(projected).not.toContain(href);
    expect(projected).toContain('Target message body');
    expect(JSON.parse(raw)).toMatchObject({ text, quotesEncoded: true });
  });
});
