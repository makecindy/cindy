// @vitest-environment jsdom
/** Test value: shared capsule is a new interactive protocol consumer. Verify real
 * component selection values, stale responses, retry and old-host fallback.
 * Previously only source-text guards covered the capsule. Minimal inputs: one
 * remote ref and a local origin/main namesake, an unresolved fetch, missing caps.
 * Tier: unit; mocked bridge only, no Git or real timers.
 */
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BranchWorktreeChip } from '../WorktreeChipsRow';
import { Tooltip } from '@/components/ui/tooltip';
const render = (element: React.ReactElement) =>
  rtlRender(element, {
    wrapper: ({ children }) => <Tooltip.Provider>{children}</Tooltip.Provider>,
  });
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  warning: vi.fn(),
  t: (key: string, args?: object) => key + (args ? JSON.stringify(args) : ''),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toast, warning: mocks.warning } }));
vi.mock('../FolderPickerPopover', () => ({
  FolderPickerPopover: () => null,
  addRecentFolder: vi.fn(),
}));
vi.mock('@/hooks/useProjectPickerOptions', () => ({ getProjectPickerDisplayName: () => '' }));
const baseStatus = {
  branch: 'main',
  remote: 'origin',
  remoteBranch: 'main',
  remoteOnly: false,
  ahead: 0,
  behind: 3,
  dirtyFiles: 2,
  checkoutPath: '/repo',
};
const status = vi.fn();
const sync = vi.fn();
const invoke = vi.fn();
const props = {
  baseRepo: '/repo',
  branchLabel: 'main',
  branches: ['main', 'origin/main'],
  branchesLoading: false,
  branchesFailed: false,
  onRetryBranches: vi.fn(),
  checked: true,
  branchSourceSelected: true,
  branchInteractive: true,
  onPick: vi.fn(),
  onOpenRequested: vi.fn(),
  onToggle: vi.fn(),
  remoteDefaultBranch: 'refs/remotes/origin/main',
};
beforeEach(() => {
  vi.clearAllMocks();
  status.mockResolvedValue(baseStatus);
  sync.mockResolvedValue({ status: { ...baseStatus, behind: 0 }, updated: 3 });
  Object.assign(window, {
    electronAPI: {
      worktreeBranchSyncStatus: status,
      worktreeSyncBranch: sync,
      deviceLink: { invoke },
    },
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const branchButton = () => screen.getByRole('button', { name: 'newChat.branchChip.label' });
const refreshButton = () => screen.getByRole('button', { name: /newChat.branchSync.action/ });
// Regression: remote Git continues after the old 90s request budget; follow the
// operation handle rather than repeating the mutation. Unit tier, real hook/UI.
it('continues waiting for the same remote fetch and shows its final result', async () => {
  const operationId = '8a7768e7-e652-4458-9c15-96af310bc9cb';
  const replies = [{ pending: true, operationId }, { pending: true, operationId }, { status: baseStatus, updated: 3 }];
  invoke.mockImplementation(async (_device, channel) => channel === 'worktree:sync-branch' ? replies.shift() : baseStatus);
  render(<BranchWorktreeChip {...props} deviceId="remote-a" />);
  await screen.findByRole('button', { name: /newChat.branchSync.action/ });
  fireEvent.click(refreshButton());
  await screen.findByRole('button', { name: /newChat.branchSync.updated/ });
  const writes = invoke.mock.calls.filter((call) => call[1] === 'worktree:sync-branch');
  expect(writes.map((call) => call[2])).toEqual([
    [{ baseRepo: '/repo', branch: 'main', waitForResult: true }],
    [{ baseRepo: '/repo', branch: 'main', waitForResult: true, operationId }],
    [{ baseRepo: '/repo', branch: 'main', waitForResult: true, operationId }],
  ]);
  expect(mocks.toast).not.toHaveBeenCalled();
});

// PR #7464: a transport rejection used to lose the operation handle. Drive the
// real component through a failed continuation and an explicit retry; terminal
// failures must instead release the handle so a later click can start new work.
it.each(['transport', 'terminal', 'selection-change'] as const)('retries after a %s failure with the correct operation identity', async (failure) => {
  const operationId = '8a7768e7-e652-4458-9c15-96af310bc9cb';
  let polls = 0;
  invoke.mockImplementation(async (_device, channel) => {
    if (channel !== 'worktree:sync-branch') return baseStatus;
    if (++polls === 1) return { pending: true, operationId };
    if (polls === 2) throw new Error(failure === 'terminal' ? 'branch-sync:changed' : 'connection lost');
    return { status: baseStatus, updated: 3 };
  });
  const view = render(<BranchWorktreeChip {...props} deviceId="remote-a" />);
  fireEvent.click(await screen.findByRole('button', { name: /newChat.branchSync.action/ }));
  let retry = await screen.findByRole('button', { name: /newChat.branchSync.failed/ });
  expect(polls).toBe(2);
  if (failure === 'selection-change') {
    view.rerender(<BranchWorktreeChip {...props} branchLabel="next" deviceId="remote-a" />);
    retry = await screen.findByRole('button', { name: /newChat.branchSync.action/ });
  }
  fireEvent.click(retry);
  await screen.findByRole('button', { name: /newChat.branchSync.updated/ });
  expect(invoke.mock.calls.filter((call) => call[1] === 'worktree:sync-branch')[2][2]).toEqual([
    { baseRepo: '/repo', branch: failure === 'selection-change' ? 'next' : 'main', waitForResult: true, ...(failure === 'transport' ? { operationId } : {}) },
  ]);
  fireEvent.click(screen.getByRole('button', { name: /newChat.branchSync.updated/ }));
  await waitFor(() => expect(polls).toBe(4));
  expect(invoke.mock.calls.filter((call) => call[1] === 'worktree:sync-branch')[3][2][0]).not.toHaveProperty('operationId');
});

it('shares counts with the selected row and keeps full remote refs distinct during keyboard search', async () => {
  render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(status).toHaveBeenCalledOnce());
  await act(async () => {
    fireEvent.click(branchButton());
  });
  expect(screen.getByRole('group', { name: 'newChat.branchSync.remoteGroup' })).toBeTruthy();
  expect(screen.getByText(/newChat.branchSync.behind/).textContent).toContain(
    'newChat.branchSync.dirty',
  );
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'origin/main' } });
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.onPick).toHaveBeenCalledWith('refs/remotes/origin/main');
  await act(async () => {
    fireEvent.click(branchButton());
  });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'origin/main' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(props.onPick).toHaveBeenLastCalledWith('origin/main');
});
// Product rule: diverged branch details name the remote once and retain dirty-file counts.
// Standard tier: exercise the real capsule with both counts positive; the existing case covers behind-only.
it('combines diverged counts into one status segment and keeps dirty files', async () => {
  status.mockResolvedValue({ ...baseStatus, ahead: 1, behind: 1, blocked: 'diverged' });
  render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(status).toHaveBeenCalledOnce());
  await act(async () => {
    fireEvent.click(branchButton());
  });
  const expected = [
    mocks.t('newChat.branchSync.diverging', {
      remote: 'origin/main',
      ahead: 1,
      behind: 1,
      count: 1,
    }),
    mocks.t('newChat.branchSync.dirty', { count: 2 }),
  ].join(' · ');
  expect(screen.getByText(expected)).toBeTruthy();
  expect(screen.queryByText(/newChat.branchSync.ahead/)).toBeNull();
  expect(screen.queryByText(/newChat.branchSync.behind/)).toBeNull();
});
it('shows remote sources only when worktree is checked or branchOnly is used', async () => {
  const view = render(<BranchWorktreeChip {...props} checked={false} />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  expect(screen.queryByRole('group', { name: 'newChat.branchSync.remoteGroup' })).toBeNull();
  view.rerender(<BranchWorktreeChip {...props} checked={false} branchOnly />);
  expect(screen.getByRole('group', { name: 'newChat.branchSync.remoteGroup' })).toBeTruthy();
});
it('hides the action when an old controlled host rejects the status channel', async () => {
  invoke.mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Old host'));
  render(<BranchWorktreeChip {...props} remoteDefaultBranch={undefined} deviceId="old-pc" />);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /newChat.branchSync/ })).toBeNull(),
  );
  expect(status).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('old-pc', 'worktree:branch-sync-status', [
    { baseRepo: '/repo', branch: 'main' },
  ]);
  expect(sync).not.toHaveBeenCalled();
});
it('blocks duplicate refresh clicks while leaving branch selection usable', async () => {
  let resolve!: (value: unknown) => void;
  sync.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  fireEvent.click(screen.getByRole('button', { name: /newChat.branchSync.fetching/ }));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  expect(screen.getByRole('combobox')).toBeTruthy();
  expect(sync).toHaveBeenCalledOnce();
  await act(async () => resolve({ status: baseStatus, updated: 3 }));
  expect(screen.getByRole('button', { name: /newChat.branchSync.updated/ })).toBeTruthy();
});
it('explains a disabled conflict, then rechecks locally on hover', async () => {
  status.mockResolvedValueOnce({ ...baseStatus, blocked: 'conflict' });
  render(<BranchWorktreeChip {...props} />);
  const button = await screen.findByRole('button', { name: /newChat.branchSync.conflict/ });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.parentElement?.tabIndex).toBe(0);
  expect(mocks.warning).not.toHaveBeenCalled();
  vi.useFakeTimers();
  fireEvent.mouseEnter(button.parentElement!);
  await act(async () => vi.advanceTimersByTime(250));
  expect(status).toHaveBeenCalledTimes(2);
  expect(refreshButton().hasAttribute('disabled')).toBe(false);
  expect(mocks.warning).not.toHaveBeenCalled();
});
it('reports failed fetches in a toast and permits retry without selecting anything', async () => {
  sync.mockRejectedValueOnce(new Error('[INTERNAL] Authentication failed'));
  render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  const retry = await screen.findByRole('button', { name: /newChat.branchSync.failed/ });
  expect(mocks.toast).toHaveBeenCalledOnce();
  expect(retry.hasAttribute('disabled')).toBe(false);
  fireEvent.click(retry);
  await screen.findByRole('button', { name: /newChat.branchSync.updated/ });
  expect(props.onPick).not.toHaveBeenCalled();
});
it('routes to the selected device and discards a late status from the previous branch', async () => {
  let resolve!: (value: unknown) => void;
  invoke
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValue({ ...baseStatus, branch: 'next' });
  const view = render(<BranchWorktreeChip {...props} deviceId="pc" />);
  view.rerender(<BranchWorktreeChip {...props} deviceId="pc" branchLabel="next" />);
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith('pc', 'worktree:branch-sync-status', [
      { baseRepo: '/repo', branch: 'next' },
    ]),
  );
  await act(async () => resolve({ ...baseStatus, blocked: 'conflict' }));
  expect(screen.queryByRole('button', { name: /newChat.branchSync.conflict/ })).toBeNull();
  fireEvent.click(refreshButton());
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith('pc', 'worktree:sync-branch', [
      { baseRepo: '/repo', branch: 'next', waitForResult: true },
    ]),
  );
  expect(status).not.toHaveBeenCalled();
});

it('keeps a fetched missing-remote result disabled across local rechecks, but clears it after changing branch', async () => {
  sync.mockResolvedValue({ status: { ...baseStatus, blocked: 'missing-remote' }, updated: 0 });
  const view = render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  const blocked = await screen.findByRole('button', { name: /newChat.branchSync.missing-remote/ });
  expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(blocked.getAttribute('aria-label'));
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  expect(mocks.warning).toHaveBeenCalledOnce();
  expect(
    screen
      .getByRole('button', { name: /newChat.branchSync.missing-remote/ })
      .hasAttribute('disabled'),
  ).toBe(true);
  view.rerender(<BranchWorktreeChip {...props} branchLabel="other" />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
});

// F01: a rejected user action should notify only its current target. Existing
// stale-read coverage cannot catch a delayed mutation response causing a toast.
it('does not warn for a blocked click result after changing branch or project', async () => {
  let resolve!: (value: unknown) => void;
  sync.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<BranchWorktreeChip {...props} />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  view.rerender(<BranchWorktreeChip {...props} baseRepo="/other" branchLabel="other" />);
  await act(async () => resolve({ status: { ...baseStatus, blocked: 'conflict' }, updated: 0 }));
  expect(mocks.warning).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});
