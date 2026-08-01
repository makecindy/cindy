// @vitest-environment jsdom

/**
 * `auto-resume` 卡承载两套彼此无关的自愈，这里锁的是它们不能互相串味：
 *
 *  1. **silent-stop 的「连接中断，已自动继续」**（上游用空回复静默收尾后续跑）——没有中断
 *     原因、没有重试次数。它必须保持原来的分隔条形态，并且用**自己的**
 *     `autoResumeSeparator.label`：本 PR 把 `autoResume.label` 的值改成了「已重新连接」
 *     （重连成功态），复用它就会让这条分隔条显示成语义错误的「重新连接」（copilot review）。
 *  2. **中断重连**——带中断原因 / 次数 / 结果，走三态活动行（✓ / ✗ / 中性）。
 *
 * 另外锁一条无障碍不变量：活动行不设 `aria-label`，否则读屏只念得到结论、听不到
 * 紧跟其后的中断原因摘要 —— 而那句摘要正是这行存在的理由。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  it('无中断信息(silent-stop) → 保持分隔条形态,且用它**自己**的文案 key', () => {
    render(<SystemCard cardType="auto-resume" data={{}} />);
    expect(screen.getByRole('separator')).toBeTruthy();
    // 关键在 key 的归属:`autoResume.label` 的值在本 PR 里已改成重连成功态
    // 「已重新连接」,分隔条复用它就等于把回归从组件层搬到 i18n 层(copilot review)。
    expect(screen.getByText('chat.systemCard.autoResumeSeparator.label')).toBeTruthy();
    for (const reconnectKey of [
      'chat.systemCard.autoResume.label',
      'chat.systemCard.autoResume.labelNeutral',
      'chat.systemCard.autoResume.labelFailed',
    ]) {
      expect(screen.queryByText(reconnectKey), `${reconnectKey} 属于重连行,不该出现在分隔条上`).toBeNull();
    }
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

  // 一次中断的"进行中"跨两种载体:退避那几秒是 ephemeral 行,续跑发出后交棒给落库的这一行。
  // 交棒之后任务确实在跑(只是还没吐出第一个可见字符),此时必须继续显示成重连中 —— 否则用户
  // 看到一个静止的「重新连接」不知道是不是还在跑(实测截图)。
  it('未回填 + 正在飞 → 「重新连接中 N/5」,文案与退避那段连续', () => {
    render(
      <SystemCard
        cardType="auto-resume"
        data={{ error: 'API Error: Connection closed mid-response.', attempt: 1, maxAttempts: 5 }}
        autoResumeInFlight
      />,
    );
    expect(
      screen.getByText('chat.systemCard.autoResumePending.labelWithProgress({"attempt":1,"total":5})'),
    ).toBeTruthy();
    expect(
      screen.queryByText('chat.systemCard.autoResume.labelNeutral'),
      '正在飞的时候不该显示中性静态文案',
    ).toBeNull();
  });

  it('已回填时 inFlight 不参与:终态优先,仍定格 ✓ / ✗', () => {
    render(
      <SystemCard
        cardType="auto-resume"
        data={{ error: 'boom', attempt: 2, maxAttempts: 5, outcome: 'succeeded' }}
        autoResumeInFlight
      />,
    );
    expect(screen.getByText('chat.systemCard.autoResume.label')).toBeTruthy();
    expect(
      screen.queryByText('chat.systemCard.autoResumePending.labelWithProgress({"attempt":2,"total":5})'),
    ).toBeNull();
  });

  it('带中断信息但 outcome 未回填 → 中性文案(落库记录永不显示"进行中",不变量 I6)', () => {
    render(
      <SystemCard cardType="auto-resume" data={{ error: 'socket hang up', attempt: 1, maxAttempts: 5 }} />,
    );
    expect(screen.getByText('chat.systemCard.autoResume.labelNeutral')).toBeTruthy();
  });

  // 上一条只锁了"用哪个 key"。**光锁 key 不够**:t 在测试里被 mock 成回显 key,
  // 所以「key 归属对了但那个 key 的值被改成了重连文案」这一层测不到 —— 而本 PR 恰恰
  // 就是把 autoResume.label 的值改成了「已重新连接」,第一次修的时候只换回了组件、
  // 没换 key,回归就藏在 i18n 层活了下来。这条直接读四个 locale 的 JSON 补上那一层。
  it('四个 locale 里分隔条文案与重连文案是两条独立的 key(值不得相同)', () => {
    const locales = ['zh-CN', 'en', 'ja', 'ko'] as const;
    for (const locale of locales) {
      const raw = readFileSync(
        resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'),
        'utf8',
      );
      const card = JSON.parse(raw).chat.systemCard;
      const separator = card.autoResumeSeparator?.label;
      const reconnected = card.autoResume?.label;
      expect(typeof separator, `${locale}: 分隔条缺少自己的文案`).toBe('string');
      expect(separator.length, `${locale}: 分隔条文案为空`).toBeGreaterThan(0);
      expect(separator, `${locale}: 分隔条不能复用重连成功态文案`).not.toBe(reconnected);
    }
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
