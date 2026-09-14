// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render as renderUI, screen } from '@testing-library/react';
import { SystemCard } from '../SystemCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
// Partner task cards have their own integration suite; isolate this sibling variant.
vi.mock('@/features/bots/BotCollaborationCard', () => ({
  BotSessionTaskCard: () => null,
  BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

const render = (ui: ReactElement) => renderUI(ui, { wrapper: MemoryRouter });

afterEach(() => cleanup());

describe('cindy-make-complete system card', () => {
  it('renders a full card with the code step and code-verified facts', () => {
    render(
      <SystemCard
        cardType="cindy-make-complete"
        sessionId="make-task"
        data={{
          reportedAt: Date.UTC(2026, 8, 10, 12, 0),
          changedFiles: 3,
          commit: 'abcdef1234567890',
        }}
      />,
    );
    expect(screen.getByRole('region', { name: 'cindyMake.complete.title' })).toBeTruthy();
    expect(screen.getByText('cindyMake.complete.description')).toBeTruthy();
    expect(screen.getByText('cindyMake.complete.stepCode')).toBeTruthy();
    const meta = screen.getByText(/cindyMake\.complete\.changedFiles/).textContent ?? '';
    expect(meta).toContain('"count":3');
    expect(meta).toContain('"commit":"abcdef123456"');
    expect(meta).not.toContain('abcdef1234567890');
  });

  it('omits the meta line when no facts were collected', () => {
    render(<SystemCard cardType="cindy-make-complete" sessionId="make-task" data={{}} />);
    expect(screen.getByRole('region', { name: 'cindyMake.complete.title' })).toBeTruthy();
    expect(screen.queryByText(/changedFiles|commit/)).toBeNull();
  });
});
