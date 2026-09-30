import { readBotCollaborationMeta } from '../../../../shared/botCollaboration';
// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotSessionTaskResultCard } from '../BotSessionTaskResultCard';
import { SystemCard } from '@/components/chat/SystemCard';
import { makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content, currentSessionId, workingDir }: any) => <a data-session={currentSessionId} data-workdir={workingDir}>{content}</a> }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({ useChatSessionFile: () => ({ origin: { kind: 'device', deviceId: 'home' }, sessionId: 'parent', workingDir: '/parent-task' }), ChatSessionFileProvider: ({ children }: any) => children }));
vi.mock('@/features/bots/BotCollaborationCard', () => ({ BotSessionTaskCard: () => null, BotSessionTaskMessageTrace: () => null }));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
const live = vi.hoisted(() => ({ row: null as any }));
vi.mock('../botDelegationLive', () => ({ useBotDelegation: vi.fn(() => live) }));
beforeEach(() => { live.row = null; });
afterEach(cleanup);
const card = { v: 1, role: 'delegation-result', delegationId: 'task-1', fromBotId: 'cindy', fromBotName: 'Cindy', toBotId: null, toBotName: 'Cindy', parentSessionId: 'parent', childSessionId: 'child', objective: 'Report', result: { workingDir: '/child-task', runSequence: 2, status: 'completed', text: 'Second result', artifacts: [{ absolutePath: '/reports/second.pdf' }] } };
it('keeps the execution result and its files in the receipt, without replacing it with live execution data', () => {
  expect(readBotCollaborationMeta(card)).toMatchObject({ role: 'delegation-result' });
  const [mapped] = makerChatStore.__mapServerMessagesForTest([{
    id: 'result-row', clientId: 'result-row', sessionId: 'parent', role: 'assistant', content: '',
    createdAt: '2026-09-23T00:00:00.000Z', agentMeta: { botCollaboration: card },
  } as Message]);
  expect(mapped.systemCardType).toBe('bot-session-task-result');
  expect(mapped.systemCardData).toMatchObject({ role: 'delegation-result', delegationId: 'task-1' });
  const { container } = render(<SystemCard cardType={mapped.systemCardType!} data={mapped.systemCardData} />);
  expect(screen.getByRole('button', { name: 'bots.collab.viewResult' }).getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.collab.viewResult' }));
  expect(container.querySelector('[hidden]')).toBeNull();
  expect(screen.getByText('Second result')).toBeTruthy();
  expect(container.querySelector('a')?.dataset.session).toBe('child');
  expect(container.querySelector('a')?.dataset.workdir).toBe('/child-task');
  expect([...container.querySelectorAll('a')].some(link => link.textContent?.includes('/reports/second.pdf'))).toBe(true);
});
it('renders image-only and linked results in the child file context', () => {
  const text = '![chart](/child-task/chart.png) [Report](https://example.com/report.pdf)';
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, text, artifacts: [] } }} />);
  const result = container.querySelector('a');
  expect(result?.textContent).toBe(text);
  expect(result?.dataset.session).toBe('child');
  expect(result?.dataset.workdir).toBe('/child-task');
  expect(screen.queryByText('bots.collab.noWrittenResult')).toBeNull();
});
it('uses human fallback for a stopped task with no result and rejects malformed receipts', () => {
  const { rerender } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status: 'cancelled', text: '', artifacts: [] } }} />);
  expect(screen.getByText('bots.collab.noWrittenResult')).toBeTruthy();
  rerender(<BotSessionTaskResultCard data={{ ...card, result: {} }} />);
  expect(screen.queryByText('Report')).toBeNull();
});

it('keeps frozen failure details behind their own disclosure', () => {
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status: 'timed-out', error: 'TIMEOUT: upstream did not finish' } }} />);
  expect(screen.getByText('bots.collab.status.timed-out')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.collab.viewResult' }));
  const details = screen.getByText('TIMEOUT: upstream did not finish').closest('details');
  expect(details?.open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('appError.details');
});

it('uses the explicit frozen title ahead of the current task and instruction', () => {
  live.row = { title: 'Renamed task', status: 'running', resultSummary: 'New output' };
  render(<BotSessionTaskResultCard data={{ ...card, objective: 'Long execution instruction', result: { ...card.result, title: 'Prepare report' } }} />);
  expect(screen.getByText('Prepare report')).toBeTruthy();
  expect(screen.queryByText('Long execution instruction')).toBeNull();
  expect(screen.queryByText('Renamed task')).toBeNull();
  expect(screen.getByText('bots.collab.status.completed')).toBeTruthy();
  expect(screen.getByText('Second result')).toBeTruthy();
});

it('recovers a legacy receipt title without taking the live status or result', () => {
  live.row = { title: 'Prepare report', status: 'running', resultSummary: 'New output' };
  const { rerender } = render(<BotSessionTaskResultCard data={{ ...card, objective: 'Long instruction' }} />);
  expect(screen.getByText('Prepare report')).toBeTruthy();
  expect(screen.getByText('bots.collab.status.completed')).toBeTruthy();
  expect(screen.getByText('Second result')).toBeTruthy();
  live.row = null;
  rerender(<BotSessionTaskResultCard data={{ ...card, objective: 'First line\nFull instruction' }} />);
  expect(screen.getByText('First line')).toBeTruthy();
  rerender(<BotSessionTaskResultCard data={{ ...card, objective: '  ' }} />);
  expect(screen.getByText('bots.collab.backgroundTask')).toBeTruthy();
});

it.each(['completed', 'failed', 'cancelled', 'timed-out'])('keeps %s readable and expandable', (status) => {
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status } }} />);
  expect(screen.getByText(`bots.collab.status.${status}`)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'bots.collab.viewResult' });
  fireEvent.click(button);
  expect(container.querySelector('[hidden]')).toBeNull();
  fireEvent.click(button);
  expect(container.querySelector('[hidden]')).toBeTruthy();
});
