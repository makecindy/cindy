import { beforeEach, describe, expect, it, vi } from 'vitest';

const goalRows = vi.hoisted(() => ({
  value: [] as Array<{ status: string; usageResetAt: number | null }>,
}));
const latestAssistant = vi.hoisted(() => ({ value: '' }));

vi.mock('../../localDb/client/current.js', () => {
  const query = {
    select: () => query,
    from: () => query,
    where: () => query,
    limit: async () => goalRows.value,
  };
  return { getDbClient: () => ({ drizzle: query }) };
});

vi.mock('../../localDb/latestMessageText.js', () => ({
  latestNonEmptyMessageText: vi.fn(async () => latestAssistant.value),
}));

import {
  buildGoalInactiveNote,
  hasTrailingGoalVerdictBlock,
  peekGoalInactiveNote,
  shouldPrependGoalInactiveNote,
} from '../inactiveNote';

const REPLY_WITH_VERDICT =
  '资源正在上传。\n\n```json\n{"goal_status":"continue","reason":"仍在上传"}\n```';

describe('goal inactive note', () => {
  beforeEach(() => {
    goalRows.value = [];
    latestAssistant.value = '';
  });

  it('只认回复末尾的裁决块', () => {
    expect(hasTrailingGoalVerdictBlock(REPLY_WITH_VERDICT)).toBe(true);
    expect(hasTrailingGoalVerdictBlock('结论\n{"goal_status":"complete","reason":"done"}')).toBe(
      true,
    );
    expect(hasTrailingGoalVerdictBlock('协议里有 "goal_status" 字段,用来裁决续跑。')).toBe(false);
    expect(hasTrailingGoalVerdictBlock('')).toBe(false);
  });

  it('末尾围栏块的 reason 含花括号时也能认出', () => {
    expect(
      hasTrailingGoalVerdictBlock(
        '已改好。\n\n```json\n{"goal_status":"continue","reason":"还要处理 {config} 段"}\n```\n',
      ),
    ).toBe(true);
    expect(
      hasTrailingGoalVerdictBlock(
        '```json\n{"goal_status":"continue"}\n```\n\n示例:\n```ts\nconst a = {};\n```',
      ),
    ).toBe(false);
  });

  it('目标不再续跑且上一条回复带裁决块时才注入', () => {
    const goal = (status: string, usageResetAt: number | null = null) => ({ status, usageResetAt });
    for (const g of [
      null,
      goal('paused'),
      goal('blocked'),
      goal('budgetLimited'),
      // 没有重置时刻的 usageLimited 不会自动恢复,停着等手动 resume。
      goal('usageLimited'),
    ]) {
      expect(
        shouldPrependGoalInactiveNote({ goal: g, latestAssistantText: REPLY_WITH_VERDICT }),
      ).toBe(true);
    }
    // active 正在续跑;带重置时刻的 usageLimited 会到点自动恢复,都不能说"不会自动继续"。
    for (const g of [goal('active'), goal('usageLimited', 1_800_000_000_000)]) {
      expect(
        shouldPrependGoalInactiveNote({ goal: g, latestAssistantText: REPLY_WITH_VERDICT }),
      ).toBe(false);
    }
    expect(shouldPrependGoalInactiveNote({ goal: null, latestAssistantText: '普通回复' })).toBe(
      false,
    );
  });

  it('说明要求停吐裁决块、不承诺自动续跑,并以用户消息边界收尾', () => {
    const note = buildGoalInactiveNote();
    expect(note).toContain('不要再输出 goal_status 裁决块');
    expect(note).toContain('不要承诺会自己接着推进');
    expect(note.endsWith('== 状态说明结束,以下是用户的新消息 ==')).toBe(true);
  });

  it('peek 按库内目标状态与最新回复现查', async () => {
    latestAssistant.value = REPLY_WITH_VERDICT;
    expect(await peekGoalInactiveNote('s1')).toBe(buildGoalInactiveNote());

    goalRows.value = [{ status: 'active', usageResetAt: null }];
    expect(await peekGoalInactiveNote('s1')).toBeNull();

    goalRows.value = [{ status: 'paused', usageResetAt: null }];
    latestAssistant.value = '模型已不再输出裁决块。';
    expect(await peekGoalInactiveNote('s1')).toBeNull();
  });
});
