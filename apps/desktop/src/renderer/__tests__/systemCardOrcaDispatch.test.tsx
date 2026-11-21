// @vitest-environment jsdom

/**
 * 派单升级卡：宿主只在 Lead 的主张补派一轮后仍无凭据时落卡，正常派单不落卡。
 *
 * 这里锁三件事：
 *  1. 正常派单（state !== 'unverified'）渲染为空 —— 异常才有可见性；
 *  2. 升级卡多行、不可折叠，正文按查看者当前语言拼装；
 *  3. 过长引文截断，队列编号进判定。
 */

import { cleanup, render, screen } from '@testing-library/react';
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

describe('SystemCard orca-dispatch 行', () => {
  it('正常派单不落卡：state 为 sent 的历史行渲染为空', () => {
    const { container } = render(
      <SystemCard
        cardType="orca-dispatch"
        data={{
          version: 1,
          state: 'sent',
          dispatchId: 'd-1',
          workerId: 'worker-1',
          workerLabel: 'developer',
          delivery: 'direct',
          summary: '三个症状一个根：改判值写进了总分',
          at: 1,
        }}
      />,
    );

    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('升级卡保持多行、不可折叠，正文按当前语言拼装', () => {
    render(
      <SystemCard
        cardType="orca-dispatch"
        data={{
          version: 1,
          state: 'unverified',
          targets: ['developer'],
          reason: 'no-dispatch',
          detail: '',
          quote: '已派给 developer，接着做行值修复',
          at: 1,
        }}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    const body = screen.getByText(/orcaDispatch\.notice\.body/);
    // 主张与判定各自取自己的文案键，模板只负责把它们和引文接成一句。
    expect(body.textContent).toContain('orcaDispatch.notice.claimTarget');
    expect(body.textContent).toContain('orcaDispatch.notice.noDispatch');
    expect(body.textContent).toContain('已派给 developer，接着做行值修复');
    // 升级卡不参与压缩 —— 它是需要主人决策的信息，压成一行等于埋掉。
    expect(body.className).toContain('whitespace-normal');
    expect(body.className).not.toContain('truncate');
    expect(screen.getByRole('note').className).toContain('px-2 py-[3px]');
  });

  it('升级卡把队列编号写进判定，过长引文截断', () => {
    render(
      <SystemCard
        cardType="orca-dispatch"
        data={{
          version: 1,
          state: 'unverified',
          targets: [],
          reason: 'unknown-message-id',
          detail: '3f1a',
          quote: 'x'.repeat(200),
          at: 1,
        }}
      />,
    );

    const body = screen.getByText(/orcaDispatch\.notice\.body/);
    expect(body.textContent).toContain('orcaDispatch.notice.unknownId');
    expect(body.textContent).toContain('3f1a');
    expect(body.textContent).not.toContain('x'.repeat(200));
  });
});
