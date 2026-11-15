// @vitest-environment jsdom

/**
 * 派发回执行：普通回执压成**一行事实**，升级卡保持**多行可读**。
 *
 * Bug 依据：回执曾把 240 字摘要整段铺开，还同时挂 `truncate` 与 `whitespace-pre-line`
 * （两个类抢同一个属性，结果折了五行）。这里锁三件事：
 *  1. 折叠态是一行，摘要不折行；
 *  2. 点一下展开、再点收起（手机没有 hover，点击是主入口），展开体走共享
 *     Collapse —— 与工具行同一套展开语言；
 *  3. 升级卡不参与压缩 —— 它是需要主人决策的信息，压成一行等于埋掉。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}(${JSON.stringify(vars)})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/bots/BotCollaborationCard', () => ({
  BotSessionTaskCard: () => null,
  BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/bots/BotSessionTaskResultCard', () => ({
  BotSessionTaskResultCard: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));

import { SystemCard } from '@/components/chat/SystemCard';

afterEach(() => {
  cleanup();
});

const sentReceipt = {
  version: 1,
  state: 'sent',
  dispatchId: 'd-1',
  workerId: 'worker-1',
  workerLabel: 'developer',
  delivery: 'direct',
  summary: '三个症状一个根：改判值写进了总分',
  at: 1,
};

describe('SystemCard orca-dispatch 行', () => {
  it('折叠态是一行事实：按钮带 aria-expanded=false，摘要不折行', () => {
    render(<SystemCard cardType="orca-dispatch" data={sentReceipt} />);

    const row = screen.getByRole('button');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('chat.systemCard.orcaDispatch.sent({"worker":"developer"})')).toBeTruthy();

    const summary = screen.getByText(sentReceipt.summary);
    expect(summary.className).toContain('truncate');
    // 两个类抢同一个属性就会出现「该截断却折行」，这条断言挡住复发。
    expect(summary.className).not.toContain('whitespace-pre-line');
  });

  it('点一下展开成三行，再点收起', () => {
    render(<SystemCard cardType="orca-dispatch" data={sentReceipt} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    // 展开后摘要移进 Collapse 正文：整段可读，不再依赖行数截断。
    const expandedSummary = screen.getByText(sentReceipt.summary);
    expect(expandedSummary.className).toContain('whitespace-pre-line');
    expect(expandedSummary.className).not.toContain('truncate');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('升级卡保持多行、不可折叠', () => {
    render(
      <SystemCard
        cardType="orca-dispatch"
        data={{
          version: 1,
          state: 'unverified',
          summary: '你说了已派给 developer，但本轮没有对应派发凭据',
          reason: 'no-dispatch-fact',
          quote: '已派给 developer',
          at: 1,
        }}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    const summary = screen.getByText('你说了已派给 developer，但本轮没有对应派发凭据');
    // 升级卡与普通回执同一套行内节奏，只差颜色；区别是它不折叠、不截断。
    expect(summary.className).toContain('whitespace-normal');
    expect(summary.className).not.toContain('truncate');
    expect(screen.getByRole('note').className).toContain('px-2 py-[3px]');
  });
});
