// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/learn/LearnStatusCard', () => ({
  LearnStatusCard: () => null,
}));

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    workingDir,
    allowPrivilegedLinks,
  }: {
    content: string;
    workingDir: string;
    allowPrivilegedLinks?: boolean;
  }) => (
    <div
      data-testid="review-markdown"
      data-working-dir={workingDir}
      data-allow-privileged-links={String(allowPrivilegedLinks)}
    >
      {content}
    </div>
  ),
}));

import { SystemCard } from '@/components/chat/SystemCard';

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderCard(data: Record<string, unknown>, workingDir = '/project') {
  return render(
    <MemoryRouter initialEntries={['/cc-agent/source-task']}>
      <SystemCard cardType="review" data={data} workingDir={workingDir} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('SystemCard Review', () => {
  it('shows the read-only running state', () => {
    renderCard({ status: 'running', reviewerSessionId: 'review-task' });

    expect(screen.getByText('chat.systemCard.review.running')).toBeTruthy();
    expect(screen.getByText('chat.systemCard.review.readOnlyHint')).toBeTruthy();
  });

  it('renders the completed findings and opens the isolated reviewer task', () => {
    renderCard({
      status: 'completed',
      reviewerSessionId: 'review-task',
      result: 'P1: src/auth.ts:42 has a regression',
    });

    const markdown = screen.getByTestId('review-markdown');
    expect(markdown.textContent).toContain('src/auth.ts:42');
    expect(markdown.getAttribute('data-working-dir')).toBe('/project');
    expect(markdown.getAttribute('data-allow-privileged-links')).toBe('true');

    fireEvent.click(screen.getByText('chat.systemCard.review.openTask'));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/review-task');
  });

  it('renders a completed stale result with its rerun reason', () => {
    renderCard({
      status: 'failed',
      reviewerSessionId: 'review-task',
      failureCode: 'source-conversation-changed',
      result: 'P2: finding from the reviewed snapshot',
    });

    expect(screen.getByText('chat.systemCard.review.stale')).toBeTruthy();
    expect(
      screen.getByText('chat.systemCard.review.failure.sourceConversationChanged'),
    ).toBeTruthy();
    const markdown = screen.getByTestId('review-markdown');
    expect(markdown.textContent).toContain('reviewed snapshot');
    expect(markdown.getAttribute('data-allow-privileged-links')).toBe('false');
    expect(screen.getByText('chat.systemCard.review.openTask')).toBeTruthy();
  });

  it.each(['source-workspace-changed', 'source-files-changed', 'artifact-changed'])(
    'does not resolve stale findings for %s against current files',
    (failureCode) => {
      renderCard({
        status: 'failed',
        reviewerSessionId: 'review-task',
        failureCode,
        result: 'P1: src/auth.ts:42 belongs to the reviewed snapshot',
      });

      const markdown = screen.getByTestId('review-markdown');
      expect(markdown.textContent).toContain('src/auth.ts:42');
      expect(markdown.getAttribute('data-working-dir')).toBe('/project');
      expect(markdown.getAttribute('data-allow-privileged-links')).toBe('false');
    },
  );

  it('renders a linked legacy stale failure as out of date without inventing result content', () => {
    renderCard({
      status: 'failed',
      reviewerSessionId: 'legacy-review-task',
      failureCode: 'source-conversation-changed',
      result: '',
    });

    expect(screen.getByText('chat.systemCard.review.stale')).toBeTruthy();
    expect(screen.queryByText('chat.systemCard.review.failed')).toBeNull();
    expect(screen.queryByTestId('review-markdown')).toBeNull();
    expect(screen.getByText('chat.systemCard.review.openTask')).toBeTruthy();
  });

  it('keeps a pre-start freshness failure as failed when no Reviewer task exists', () => {
    renderCard({
      status: 'failed',
      failureCode: 'artifact-changed',
      result: '',
    });

    expect(screen.getByText('chat.systemCard.review.failed')).toBeTruthy();
    expect(screen.queryByText('chat.systemCard.review.stale')).toBeNull();
    expect(screen.queryByText('chat.systemCard.review.openTask')).toBeNull();
  });

  it('translates a stable persisted failure code ahead of internal diagnostic text', () => {
    renderCard({
      status: 'failed',
      failureCode: 'reviewer-closed',
      error: 'Reviewer task was closed before it finished',
    });

    expect(screen.getByText('chat.systemCard.review.failed')).toBeTruthy();
    expect(screen.getByText('chat.systemCard.review.failure.reviewerClosed')).toBeTruthy();
    expect(screen.queryByText('Reviewer task was closed before it finished')).toBeNull();
    expect(screen.queryByTestId('review-markdown')).toBeNull();
    expect(screen.queryByText('chat.systemCard.review.openTask')).toBeNull();
  });

  it('localizes legacy built-in errors while preserving unknown provider detail', () => {
    const { rerender } = renderCard({
      status: 'failed',
      error: 'Review refused a multiply linked file in its artifact workspace',
    });
    expect(screen.getByText('chat.systemCard.review.failure.artifactUnavailable')).toBeTruthy();

    rerender(
      <MemoryRouter initialEntries={['/cc-agent/source-task']}>
        <SystemCard
          cardType="review"
          data={{ status: 'failed', error: 'provider-specific failure' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText('provider-specific failure')).toBeTruthy();
  });
});
