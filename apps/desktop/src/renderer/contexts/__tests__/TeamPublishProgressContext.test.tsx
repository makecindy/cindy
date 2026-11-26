/** @vitest-environment jsdom */
/**
 * #1541 review fix: an organization publish started from the UI reports its progress and outcome,
 * even after the user leaves the plugin page. Protects: after the user confirms, a refusal from
 * the service reaches the user; cancelling stays silent; a page that unmounts mid-publish still
 * gets the result when it comes back; other accounts' transfers are not shown.
 * Entry: TeamPublishProgressProvider + TeamPublishResults with the real progress push shape.
 * Minimal failing input: unmount the page between start and the `succeeded` push. jsdom tier.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamPublishResults } from '../../features/plugin/team/TeamPublishResults';
import { TeamPublishProgressProvider, useTeamPublishProgress } from '../TeamPublishProgressContext';

const i18n = vi.hoisted(() => ({ t: (key: string, args?: Record<string, unknown>) => `${key} ${args?.name ?? ''}`.trim() }));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
const toasts = vi.hoisted(() => ({
  loading: vi.fn(() => 'toast-1'), update: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toasts }));
const auth = vi.hoisted(() => ({ owner: 'A', membershipKind: 'org' }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({
  dataOwnerId: auth.owner, dataOwnerGeneration: 1, user: { id: auth.owner, membershipKind: auth.membershipKind }, mode: 'cloud',
}) }));

const copy = 'settings.ghosts.publish.progress';
let push: ((progress: unknown) => void) | null = null;

/** Stands in for the plugin page: starts a publish when mounted, can be navigated away from. */
function StartPage({ transferId, name }: { transferId: string; name: string }) {
  const { track } = useTeamPublishProgress();
  useEffect(() => { track(transferId, name); }, [track, transferId, name]);
  return null;
}
function app(page: 'start' | 'results' | 'other', transferId = 't1', name = 'Meeting Notes') {
  return <TeamPublishProgressProvider>
    {page === 'start' ? <StartPage transferId={transferId} name={name} /> : page === 'results' ? <TeamPublishResults /> : <p>chat</p>}
  </TeamPublishProgressProvider>;
}
const shown = () => screen.queryAllByRole('status').map((item) => item.textContent);

beforeEach(() => {
  auth.owner = 'A'; auth.membershipKind = 'org';
  Object.values(toasts).forEach((mock) => mock.mockClear());
  Object.assign(window, {
    electronAPI: {
      pluginPublisher: {
        onProgress: (callback: (progress: unknown) => void) => { push = callback; return () => { push = null; }; },
        status: vi.fn(async () => ({ progress: null })),
      },
    },
  });
});
afterEach(cleanup);

describe('TeamPublishProgressProvider', () => {
  it('shows progress, then the refusal the user needs to act on', () => {
    render(app('start'));
    act(() => push?.({ transferId: 't1', stage: 'uploading', bytesSent: 5, totalBytes: 10 }));
    expect(toasts.loading).toHaveBeenCalledWith(`${copy}.uploading Meeting Notes`);
    act(() => push?.({ transferId: 'other', stage: 'failed', errorCode: 'INTERNAL' }));
    expect(toasts.error).not.toHaveBeenCalled();
    act(() => push?.({ transferId: 't1', stage: 'failed', errorCode: 'PUBLISH_VERSION_EXISTS' }));
    expect(toasts.dismiss).toHaveBeenCalledWith('toast-1');
    expect(toasts.error).toHaveBeenCalledWith(`${copy}.versionExists Meeting Notes`);
  });

  // #1593: a publish the server rejects for anyone was already explained on the confirmation
  // screen; the result says so instead of "try again later".
  it('reports a publish the server does not allow as not allowed, not as a retryable failure', () => {
    render(app('start'));
    act(() => push?.({ transferId: 't1', stage: 'failed', errorCode: 'PLUGIN_ARCHIVED' }));
    expect(toasts.error).toHaveBeenCalledWith(`${copy}.notAllowed Meeting Notes`);
  });

  it('keeps following after the page is left and lists in-progress and finished results on return', () => {
    const view = render(app('start'));
    act(() => push?.({ transferId: 't1', stage: 'hashing' }));
    view.rerender(app('other'));
    view.rerender(app('results'));
    expect(shown()).toEqual([`${copy}.publishing Meeting Notes`]);
    view.rerender(app('other'));
    act(() => push?.({ transferId: 't1', stage: 'succeeded', reviewStatus: 'pending', version: '1.0.0' }));
    expect(toasts.success).toHaveBeenCalledWith(`${copy}.submitted Meeting Notes`);
    view.rerender(app('results'));
    expect(shown()).toEqual([`${copy}.submitted Meeting Notes`]);
    fireEvent.click(screen.getByRole('button', { name: `${copy}.dismiss` }));
    expect(shown()).toEqual([]);
  });

  it('stays silent when the user cancels and forgets transfers after an account switch', () => {
    const view = render(app('start'));
    act(() => push?.({ transferId: 't1', stage: 'failed', errorCode: 'CONFIRM_UNAVAILABLE' }));
    view.rerender(app('start', 't2', 'Ticket Router'));
    act(() => push?.({ transferId: 't2', stage: 'hashing' }));
    auth.owner = 'B';
    view.rerender(app('results'));
    act(() => push?.({ transferId: 't2', stage: 'succeeded', reviewStatus: 'pending', version: '1.0.0' }));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });

  // Greptile review on #12208: a team publish the conversation started is not tracked by this
  // window, yet its success must still let the team list read again. Minimal failing input: a
  // `succeeded` push for an untracked transfer.
  it('counts successful team publishes started anywhere, once per transfer', () => {
    function Signal() {
      return <output>{useTeamPublishProgress().publishedSignal}</output>;
    }
    render(<TeamPublishProgressProvider><Signal /></TeamPublishProgressProvider>);
    expect(screen.getByRole('status').textContent).toBe('0');
    act(() => push?.({ transferId: 'chat-1', stage: 'uploading', bytesSent: 1, totalBytes: 2 }));
    expect(screen.getByRole('status').textContent).toBe('0');
    act(() => push?.({ transferId: 'chat-1', stage: 'succeeded', reviewStatus: 'pending', version: '0.1.0' }));
    act(() => push?.({ transferId: 'chat-1', stage: 'succeeded', reviewStatus: 'pending', version: '0.1.0' }));
    expect(screen.getByRole('status').textContent).toBe('1');
    expect(toasts.success).not.toHaveBeenCalled();
  });
});
