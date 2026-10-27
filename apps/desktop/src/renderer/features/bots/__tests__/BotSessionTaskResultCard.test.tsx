// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readBotCollaborationMeta } from '../../../../shared/botCollaboration';
import { BotSessionTaskResultCard } from '../BotSessionTaskResultCard';
import { SystemCard } from '@/components/chat/SystemCard';
import { makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';

const live = vi.hoisted(() => ({ row: null as any, open: (() => {}) as () => void }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content, currentSessionId, workingDir }: any) => <a data-session={currentSessionId} data-workdir={workingDir}>{content}</a> }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({ useChatSessionFile: () => ({ origin: { kind: 'device', deviceId: 'home' }, sessionId: 'parent', workingDir: '/parent-task' }), ChatSessionFileProvider: ({ children }: any) => children }));
vi.mock('@/features/bots/BotCollaborationCard', async (importOriginal) => ({
  ...await importOriginal<typeof import('../BotCollaborationCard')>(),
  BotSessionTaskCard: () => null,
  BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));
// The original task's live identity; the receipt must not take status or text from it.
vi.mock('../BotSessionTaskLink', () => ({
  useBotTaskSession: () => ({
    row: live.row, resolved: true, stale: false, targetId: 'child', session: null, sourceDeviceId: undefined,
    activity: null, running: live.row?.status === 'running', originConflict: false, open: live.open,
  }),
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: false }) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ registerPrConsumer: () => () => {}, invalidateRemotePrRefs: () => {} }),
  usePrRefsForSession: () => [],
  usePrStatuses: () => ({ statuses: new Map(), successfulStatuses: new Map(), refreshError: false }),
}));
beforeEach(() => { live.row = null; live.open = vi.fn(); });
afterEach(cleanup);
const card = { v: 1, role: 'delegation-result', delegationId: 'task-1', fromBotId: 'cindy', fromBotName: 'Cindy', toBotId: null, toBotName: 'Cindy', parentSessionId: 'parent', childSessionId: 'child', objective: 'Report', result: { workingDir: '/child-task', runSequence: 2, status: 'completed', text: 'Second result', artifacts: [{ absolutePath: '/reports/second.pdf' }] } };
const resultLinks = (container: HTMLElement) => [...container.querySelectorAll('a')];

it('keeps the execution result and its files in the receipt, without replacing it with live execution data', () => {
  expect(readBotCollaborationMeta(card)).toMatchObject({ role: 'delegation-result' });
  const [mapped] = makerChatStore.__mapServerMessagesForTest([{
    id: 'result-row', clientId: 'result-row', sessionId: 'parent', role: 'assistant', content: '',
    createdAt: '2026-09-23T00:00:00.000Z', agentMeta: { botCollaboration: card },
  } as Message]);
  expect(mapped.systemCardType).toBe('bot-session-task-result');
  expect(mapped.systemCardData).toMatchObject({ role: 'delegation-result', delegationId: 'task-1' });
  const { container } = render(<SystemCard cardType={mapped.systemCardType!} data={mapped.systemCardData} />);
  // A standalone fallback receipt starts collapsed: the summary line, then the result on demand.
  const toggle = screen.getByRole('button', { name: /bots\.collab\.expandResult/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(resultLinks(container)).toHaveLength(0);
  expect(screen.getByText('Second result')).toBeTruthy();
  fireEvent.click(toggle);
  expect(resultLinks(container)[0].textContent).toBe('Second result');
  expect(resultLinks(container)[0].dataset.session).toBe('child');
  expect(resultLinks(container)[0].dataset.workdir).toBe('/child-task');
  expect(resultLinks(container).some(link => link.textContent?.includes('/reports/second.pdf'))).toBe(true);
  expect(screen.getByRole('button', { name: /bots\.collab\.artifactCount/ })).toBeTruthy();
});

it('opens the result by default under the closing reply and names the task once', () => {
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, title: 'Prepare report' } }} attached />);
  expect(screen.getByRole('button', { name: /bots\.collab\.collapseResult/ }).getAttribute('aria-expanded')).toBe('true');
  expect(resultLinks(container)[0].textContent).toBe('Second result');
  expect(screen.getAllByText('Prepare report')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare report' }));
  expect(live.open).toHaveBeenCalled();
});

it('renders image-only and linked results in the child file context', () => {
  const text = '![chart](/child-task/chart.png) [Report](https://example.com/report.pdf)';
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, text, artifacts: [] } }} attached />);
  const result = container.querySelector('a');
  expect(result?.textContent).toBe(text);
  expect(result?.dataset.session).toBe('child');
  expect(result?.dataset.workdir).toBe('/child-task');
  expect(screen.queryByText('bots.collab.noWrittenResult')).toBeNull();
});

it('uses human fallback for a stopped task with no result and rejects malformed receipts', () => {
  const { rerender } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status: 'cancelled', text: '', artifacts: [] } }} />);
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.expandDetails/ }));
  expect(screen.getByText('bots.collab.noWrittenResult')).toBeTruthy();
  rerender(<BotSessionTaskResultCard data={{ ...card, result: {} }} />);
  expect(screen.queryByText('Report')).toBeNull();
});

it('keeps frozen failure details behind their own disclosure', () => {
  render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status: 'timed-out', error: 'TIMEOUT: upstream did not finish' } }} />);
  expect(screen.getByText('bots.collab.status.timed-out')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /bots\.collab\.expandDetails/ }));
  const details = screen.getByText('TIMEOUT: upstream did not finish', { selector: 'p' }).closest('details');
  expect(details?.open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('appError.details');
});

it('uses the explicit frozen title ahead of the current task and instruction', () => {
  live.row = { title: 'Renamed task', status: 'running', resultSummary: 'New output', artifacts: [] };
  render(<BotSessionTaskResultCard data={{ ...card, objective: 'Long execution instruction', result: { ...card.result, title: 'Prepare report' } }} />);
  expect(screen.getByText('Prepare report')).toBeTruthy();
  expect(screen.queryByText('Long execution instruction')).toBeNull();
  expect(screen.queryByText('Renamed task')).toBeNull();
  expect(screen.getByText('bots.collab.status.completed')).toBeTruthy();
  expect(screen.getByText('Second result')).toBeTruthy();
  expect(screen.queryByText('New output')).toBeNull();
  expect(screen.queryByRole('button', { name: /bots\.collab\.stop/ })).toBeNull();
});

it('recovers a legacy receipt title without taking the live status or result', () => {
  live.row = { title: 'Prepare report', status: 'running', resultSummary: 'New output', artifacts: [] };
  const { rerender } = render(<BotSessionTaskResultCard data={{ ...card, objective: 'Long instruction' }} />);
  expect(screen.getByText('Prepare report')).toBeTruthy();
  expect(screen.getByText('bots.collab.status.completed')).toBeTruthy();
  expect(screen.getByText('Second result')).toBeTruthy();
  live.row = null;
  rerender(<BotSessionTaskResultCard data={{ ...card, objective: 'First line\nFull instruction' }} />);
  expect(screen.getByText('First line')).toBeTruthy();
  rerender(<BotSessionTaskResultCard data={{ ...card, objective: '  ' }} />);
  expect(screen.getByRole('button', { name: 'bots.collab.backgroundTask' })).toBeTruthy();
});

it.each([
  ['completed', 'expandResult', 'collapseResult'],
  ['failed', 'expandDetails', 'collapseDetails'],
  ['cancelled', 'expandDetails', 'collapseDetails'],
  ['timed-out', 'expandDetails', 'collapseDetails'],
])('keeps %s readable and expandable', (status, expand, collapse) => {
  const { container } = render(<BotSessionTaskResultCard data={{ ...card, result: { ...card.result, status } }} />);
  expect(screen.getByText(`bots.collab.status.${status}`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`bots\\.collab\\.${expand}`) }));
  expect(resultLinks(container).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`bots\\.collab\\.${collapse}`) }));
  expect(resultLinks(container)).toHaveLength(0);
});
