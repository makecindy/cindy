/**
 * goal 状态标签 / reason 文案的判定。
 *
 * 断言的核心: 上游过载与账号限流共用 `usageLimited` 状态, 但对用户的说法必须分开 ——
 * 账号从没被限流时说「用量受限」是假信息, 而 reason 的裸英文判据串不能直接推给用户
 * (review #844 codex P1)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import {
  GOAL_OVERLOAD_LAST_REASON,
  GOAL_TOOL_LOOP_LAST_REASON,
  GOAL_STATUS_LABEL,
  goalReasonText,
  goalStatusLabel,
} from '@/session/goalStatusLabel';

describe('goalStatusLabel', () => {
  it('过载退避说「模型服务繁忙」, 不说「用量受限」', () => {
    const label = goalStatusLabel('usageLimited', GOAL_OVERLOAD_LAST_REASON);
    expect(label).toBe(i18n.t('interaction.contextSheet.goalStatus.capacityLimited'));
    expect(label).not.toBe(GOAL_STATUS_LABEL.usageLimited);
  });

  it('账号限流仍说「用量受限」', () => {
    expect(goalStatusLabel('usageLimited', 'usage limit reached')).toBe(
      GOAL_STATUS_LABEL.usageLimited,
    );
    // 旧记录 / 没有 reason 时沿用原标签。
    expect(goalStatusLabel('usageLimited', null)).toBe(GOAL_STATUS_LABEL.usageLimited);
    expect(goalStatusLabel('usageLimited')).toBe(GOAL_STATUS_LABEL.usageLimited);
  });

  it('其它状态不受 reason 影响', () => {
    expect(goalStatusLabel('active', GOAL_OVERLOAD_LAST_REASON)).toBe(GOAL_STATUS_LABEL.active);
    expect(goalStatusLabel('blocked', GOAL_OVERLOAD_LAST_REASON)).toBe(GOAL_STATUS_LABEL.blocked);
  });
});

describe('goalReasonText', () => {
  it('过载判据串换成本地化说明, 不外发内部英文', () => {
    const text = goalReasonText(GOAL_OVERLOAD_LAST_REASON);
    expect(text).toBe(i18n.t('interaction.contextSheet.goalCapacityHint'));
    expect(text).not.toBe(GOAL_OVERLOAD_LAST_REASON);
  });

  it('工具循环判据串换成本地化说明, 不外发模型原始 message', () => {
    const text = goalReasonText(GOAL_TOOL_LOOP_LAST_REASON);
    expect(text).toBe(i18n.t('session.tail.toolUseLoopDetected'));
    expect(text).not.toContain('missing_required_field');
  });

  it('空 reason 不渲染; 其它 reason 沿用原文(既有行为)', () => {
    expect(goalReasonText(null)).toBeNull();
    expect(goalReasonText(undefined)).toBeNull();
    expect(goalReasonText('')).toBeNull();
    expect(goalReasonText('budget limit reached')).toBe('budget limit reached');
  });
});

describe('两处状态标签渲染都走 reason-aware 取值', () => {
  // 这个标签有两处渲染(Context 面板的状态 chip 与会话页顶部)。任一处退回按状态直取
  // GOAL_STATUS_LABEL[...], 过载退避就会重新显示成「用量受限」—— 正是 review #844
  // 要修的假信息。用源码断言把两处一起钉住。
  const readTextLf = (path: string): string =>
    String(readFileSync(path, 'utf8')).replace(/\r\n/g, '\n');

  it.each([
    ['src/session/ContextSheetGoalView.tsx'],
    ['app/sessions/[sessionId].tsx'],
  ])('%s 用 goalStatusLabel(status, lastReason) 而不是按状态直取', (relPath) => {
    const source = readTextLf(resolve(process.cwd(), relPath));
    expect(source).toContain('goalStatusLabel(');
    expect(source).not.toMatch(/GOAL_STATUS_LABEL\s*\[/);
  });
});
