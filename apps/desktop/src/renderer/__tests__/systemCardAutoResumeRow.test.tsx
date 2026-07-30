// @vitest-environment jsdom

/**
 * `auto-resume` 卡承载两套彼此无关的自愈，这里锁的是它们不能互相串味：
 *
 *  1. **silent-stop 的「已自动继续」**（上游用空回复静默收尾后续跑）——没有中断原因、
 *     没有重试次数。它必须保持原来的分隔条形态与 `autoResume.label` 文案；一旦被中断
 *     重连那套三态改写，历史里会出现语义错误的「重新连接」（copilot review）。
 *  2. **中断重连**——带中断原因 / 次数 / 结果，走三态活动行（✓ / ✗ / 中性）。
 *
 * 另外锁一条无障碍不变量：活动行不设 `aria-label`，否则读屏只念得到结论、听不到
 * 紧跟其后的中断原因摘要 —— 而那句摘要正是这行存在的理由。
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  // t 直接回 key:断言落在"用了哪条文案"上,不受具体译文改动影响。
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}(${JSON.stringify(vars)})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/learn/LearnStatusCard', () => ({
  LearnStatusCard: () => null,
}));

import { SystemCard } from '@/components/chat/SystemCard';

afterEach(() => {
  cleanup();
});

describe('SystemCard auto-resume 行', () => {
  it('无中断信息(silent-stop) → 保持「已自动继续」分隔条,不套用重连文案', () => {
    render(<SystemCard cardType="auto-resume" data={{}} />);
    expect(screen.getByText('chat.systemCard.autoResume.label')).toBeTruthy();
    // 中性重连文案属于"中断重连但结果未回填",不该出现在 silent-stop 行上。
    expect(screen.queryByText('chat.systemCard.autoResume.labelNeutral')).toBeNull();
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('带中断信息 + outcome=failed → 三态活动行显示「重新连接未成功」', () => {
    render(
      <SystemCard
        cardType="auto-resume"
        data={{
          error: 'API Error: Connection closed mid-response.',
          attempt: 2,
          maxAttempts: 5,
          sessionTotal: 3,
          outcome: 'failed',
        }}
      />,
    );
    expect(screen.getByText('chat.systemCard.autoResume.labelFailed')).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('带中断信息但 outcome 未回填 → 中性文案(落库记录永不显示"进行中",不变量 I6)', () => {
    render(
      <SystemCard cardType="auto-resume" data={{ error: 'socket hang up', attempt: 1, maxAttempts: 5 }} />,
    );
    expect(screen.getByText('chat.systemCard.autoResume.labelNeutral')).toBeTruthy();
  });

  it('活动行不设 aria-label:无障碍名要包含中断原因摘要', () => {
    render(
      <SystemCard
        cardType="auto-resume"
        data={{ error: 'API Error: 502 upstream unreachable', attempt: 1, maxAttempts: 5, outcome: 'succeeded' }}
      />,
    );
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBeNull();
    // 可见文本 = 结论 + 摘要,读屏据此拼出无障碍名。
    expect(button.textContent).toContain('chat.systemCard.autoResume.label');
    expect(button.textContent).toContain('502 upstream unreachable');
  });
});
