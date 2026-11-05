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
import { BranchWorktreeChip, WorktreeChipsRow } from '../WorktreeChipsRow';
import { Tooltip } from '@/components/ui/tooltip';
const render = (element: React.ReactElement) =>
  rtlRender(element, {
    wrapper: ({ children }) => <Tooltip.Provider>{children}</Tooltip.Provider>,
  });
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  t: (key: string, args?: object) => key + (args ? JSON.stringify(args) : ''),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toast,
    warning: mocks.warning,
    success: mocks.success,
    info: mocks.info,
    dismiss: mocks.dismiss,
  },
}));
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
  mocks.success.mockReturnValue('checkout-success-toast');
  mocks.info.mockReturnValue('checkout-info-toast');
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
  const replies = [
    { pending: true, operationId },
    { pending: true, operationId },
    { status: baseStatus, updated: 3 },
  ];
  invoke.mockImplementation(async (_device, channel) =>
    channel === 'worktree:sync-branch' ? replies.shift() : baseStatus,
  );
  render(<BranchWorktreeChip {...props} deviceId="remote-a" />);
  // The action exists while the initial status is still loading; wait until a
  // user can click it before checking remote operation continuation.
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
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
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  let retry = await screen.findByRole('button', { name: /newChat.branchSync.failed/ });
  expect(polls).toBe(2);
  if (failure === 'selection-change') {
    view.rerender(<BranchWorktreeChip {...props} branchLabel="next" deviceId="remote-a" />);
    await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
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
it('offers origin sources while unchecked without a separate unchecked sync mutation', async () => {
  render(<BranchWorktreeChip {...props} checked={false} />);
  await act(async () => {
    fireEvent.click(branchButton());
  });
  expect(screen.getByRole('group', { name: 'newChat.branchSync.remoteGroup' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /newChat.branchSync.action/ })).toBeNull();
  fireEvent.click(screen.getAllByRole('option', { name: 'origin/main' })[0]);
  expect(props.onPick).toHaveBeenCalledWith('refs/remotes/origin/main');
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

// Regression: the unchecked chip used the remembered worktree source while the
// session would run on main. Exercise the real row and hooks, mocking only IPC.
const checkoutStatus = {
  current: 'main',
  head: 'head',
  fingerprint: 'fingerprint',
  files: [],
  sessions: [],
  occupied: [],
  carryAllowed: true,
  stashes: [],
};
function setupCheckout(supportsCheckout = true, overrides = {}) {
  const checkout = vi.fn().mockResolvedValue({ status: { ...checkoutStatus, ...overrides } });
  Object.assign(window.electronAPI, {
    worktreeDetectCwd: vi.fn().mockResolvedValue({
      isGitRepo: true,
      gitInstalled: true,
      isInsideWorktree: false,
      repoRoot: '/repo',
      currentBranch: 'main',
      supportsCheckout,
    }),
    worktreeListBranches: vi.fn().mockResolvedValue({
      current: 'main',
      branches: ['main', 'feature'],
      remoteDefaultBranch: 'refs/remotes/origin/main',
    }),
    worktreeSuggestName: vi.fn().mockResolvedValue({ name: 'test' }),
    worktreeCheckout: checkout,
  });
  return checkout;
}
function CheckoutRow({
  deviceId,
  onSourceChange,
  remembered = 'remembered-source',
  defaultSource,
}: {
  deviceId?: string;
  onSourceChange?: (branch: string) => void;
  remembered?: string;
  defaultSource?: (value: { sourceBranch: string }) => void;
} = {}) {
  const [enabled, setEnabled] = React.useState(false);
  const [source, setSource] = React.useState(remembered);
  return (
    <WorktreeChipsRow
      cwd="/repo"
      deviceLinkDeviceId={deviceId}
      enabled={enabled}
      onEnabledChange={setEnabled}
      sourceBranch={source}
      onDefaultSourceBranchChange={defaultSource}
      onSourceBranchChange={(branch) => {
        onSourceChange?.(branch);
        setSource(branch);
      }}
      variant="advancedOnly"
    />
  );
}
// A pending checkout now occupies the former chevron slot. Verify the real row
// announces pending work and prevents another pick until the IPC completes;
// the checkout UI fixture measures its width and right-aligned position.
it('shows pending checkout until its reply arrives and prevents duplicate branch picks', async () => {
  const checkout = setupCheckout();
  let resolve!: (reply: unknown) => void;
  checkout.mockImplementation(async (req) => {
    if (req.action === 'switch')
      return new Promise((done) => {
        resolve = done;
      });
    return { status: checkoutStatus };
  });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  });
  await waitFor(() => expect(branchButton().getAttribute('aria-busy')).toBe('true'));
  expect(branchButton().getAttribute('aria-disabled')).toBe('true');
  expect(branchButton().textContent).toBe('main');
  fireEvent.click(branchButton());
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(checkout.mock.calls.filter(([req]) => req.action === 'switch')).toHaveLength(1);
  await act(async () => resolve({ status: { ...checkoutStatus, current: 'feature' } }));
  await waitFor(() => expect(branchButton().getAttribute('aria-busy')).toBeNull());
  expect(branchButton().getAttribute('aria-disabled')).toBe('false');
  expect(branchButton().textContent).toBe('feature');
});
it('shows actual checkout when off and the remembered source when on; toggles never mutate Git', async () => {
  const checkout = setupCheckout();
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
  });
  await waitFor(() => expect(branchButton().textContent).toBe('remembered-source'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
  });
  expect(branchButton().textContent).toBe('main');
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
});
it('disables checkout choices while a task is running; explicit worktree keeps the menu open', async () => {
  const checkout = setupCheckout(true, {
    blocked: 'busy',
    sessions: [{ id: 'a', name: 'Active', running: true }],
  });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /feature/ }).getAttribute('aria-disabled')).toBe(
      'true',
    ),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: /feature/ }));
  });
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'newChat.checkout.useWorktree' }));
  });
  expect(screen.getByRole('listbox')).toBeTruthy();
  expect(branchButton().textContent).toBe('remembered-source');
  expect(screen.getByTestId('create-agent-worktree-chip').getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.getByRole('option', { name: 'feature' }).getAttribute('aria-disabled')).toBe(
    'false',
  );
});
it('lets the user cancel dirty checkout or choose worktree without any Git mutation', async () => {
  const checkout = setupCheckout(true, { files: ['changed.txt'] });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  });
  await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  });
  await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'newChat.checkout.useWorktree' }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(branchButton().textContent).toBe('feature');
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
});
// A clean porcelain status can still hide ignored files that the target would overwrite.
it('explains ignored-only collisions before any checkout or stash request', async () => {
  const checkout = setupCheckout();
  checkout.mockImplementation(async (req) => ({
    status: {
      ...checkoutStatus,
      ...(req.branch === 'feature'
        ? {
            blocked: 'conflict',
            carryAllowed: false,
            ignoredCollision: { branch: 'feature', paths: ['private/collision', 'other-file'] },
          }
        : {}),
    },
  }));
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  });
  const explanation = mocks.toast.mock.calls.at(-1)?.[0];
  expect(explanation).toContain('feature');
  expect(explanation).toContain('private/collision');
  expect(explanation).toContain('"count":2');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
  expect(branchButton().textContent).toBe('main');
});
it('keeps an old execution host read-only and never invokes the new channel', async () => {
  const checkout = setupCheckout(false);
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  expect(branchButton().getAttribute('aria-disabled')).toBe('true');
  expect(checkout).not.toHaveBeenCalled();
});

// Regression: a lost mutation/result response must recover the same operation's
// receipt, with bounded read retries and no second Git write. Checkout and undo
// must leave worktree preferences untouched (user rule B); old tests expected writes.
it.each(['direct', 'lost-write', 'lost-result', 'unreachable'])(
  'recovers checkout and undo through the execution computer: %s',
  async (mode) => {
    const checkout = setupCheckout();
    let current = 'main';
    let operationId: string;
    let resultReads = 0;
    const switched = () => ({
      status: { ...checkoutStatus, current },
      receipt: {
        id: 'receipt',
        from: 'main',
        to: current,
        strategy: 'carry',
        hadChanges: false,
        sessions: [{ id: 'idle', name: 'Idle task', running: false }],
      },
    });
    checkout.mockImplementation(async (req) => {
      if (req.action === 'switch') {
        current = 'feature';
        operationId = req.operationId;
        if (mode === 'lost-write' || mode === 'unreachable') throw new Error('Lost reply');
        if (mode === 'lost-result') return { pending: true, operationId };
        return switched();
      }
      if (req.action === 'result') {
        expect(req.operationId).toBe(operationId);
        resultReads++;
        if (mode === 'unreachable' || resultReads === 1) throw new Error('Result not received');
        return switched();
      }
      if (req.action === 'undo') current = 'main';
      return { status: { ...checkoutStatus, current } };
    });
    invoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'worktree:checkout') return checkout(args[0]);
      if (channel === 'worktree:detect-cwd') return window.electronAPI.worktreeDetectCwd(args[0]);
      if (channel === 'worktree:list-branches')
        return window.electronAPI.worktreeListBranches(args[0]);
      if (channel === 'worktree:suggest-name')
        return window.electronAPI.worktreeSuggestName(args[0]);
      return baseStatus;
    });
    const onSourceChange = vi.fn();
    render(<CheckoutRow deviceId="execution-pc" onSourceChange={onSourceChange} />);
    await waitFor(() => expect(branchButton().textContent).toBe('main'));
    await act(async () => {
      fireEvent.click(branchButton());
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
    });
    await waitFor(() => expect(branchButton().textContent).toBe('feature'));
    expect(checkout.mock.calls.filter(([req]) => req.action === 'switch')).toHaveLength(1);
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'switch',
        branch: 'feature',
        expected: 'main',
        strategy: 'carry',
      }),
    );
    expect(resultReads).toBe(mode === 'direct' ? 0 : 2);
    expect(invoke.mock.calls.every(([deviceId]) => deviceId === 'execution-pc')).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
    });
    if (mode === 'unreachable') {
      expect(branchButton().textContent).toBe('remembered-source');
      expect(screen.queryByRole('button', { name: 'newChat.checkout.undo' })).toBeNull();
      expect(mocks.toast).toHaveBeenCalledWith('newChat.checkout.errors.git');
      expect(mocks.success).not.toHaveBeenCalled();
      expect(checkout.mock.calls.at(-1)?.[0].action).toBe('status');
      return;
    }
    expect(branchButton().textContent).toBe('remembered-source');
    expect(onSourceChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
    });
    await act(async () => {
      const [message, options] = mocks.success.mock.calls.at(-1)!;
      expect(message).toContain('newChat.checkout.switched');
      expect(options.duration).toBe(8000);
      expect(options.action.label).toBe('newChat.checkout.undo');
      options.action.onClick();
    });
    await waitFor(() => expect(branchButton().textContent).toBe('main'));
    expect(mocks.success).toHaveBeenLastCalledWith('newChat.checkout.undone');
    expect(onSourceChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
    });
    expect(branchButton().textContent).toBe('remembered-source');
  },
);

// Saved changes remain discoverable after the toast expires, without adding any
// inline recovery content to the controls row. Re-reading status does not re-toast.
it.each(['toast', 'menu'])('restores saved changes from the %s action', async (entry) => {
  const checkout = setupCheckout();
  let stashes = [{ id: 'saved', branch: 'main' }];
  checkout.mockImplementation(async (req) => {
    if (req.action === 'restore') stashes = [];
    return { status: { ...checkoutStatus, stashes } };
  });
  render(<CheckoutRow />);
  await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
  const options = mocks.info.mock.calls[0][1];
  expect(options.duration).toBe(8000);
  expect(screen.queryByRole('button', { name: 'newChat.checkout.restore' })).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(mocks.info).toHaveBeenCalledOnce();
  await act(async () => {
    fireEvent.click(branchButton());
  });
  const restoreButton = screen.getByRole('button', { name: 'newChat.checkout.restore' });
  await act(async () => {
    if (entry === 'toast') options.action.onClick();
    else fireEvent.click(restoreButton);
  });
  expect(checkout.mock.calls.filter(([req]) => req.action === 'restore')).toHaveLength(1);
  expect(mocks.success).toHaveBeenLastCalledWith('newChat.checkout.restored');
  expect(screen.queryByRole('button', { name: 'newChat.checkout.restore' })).toBeNull();
});

it('dismisses the recovery toast and ignores its action after leaving the checkout', async () => {
  const checkout = setupCheckout(true, { stashes: [{ id: 'saved', branch: 'main' }] });
  const view = render(<CheckoutRow />);
  await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
  const action = mocks.info.mock.calls[0][1].action;
  view.unmount();
  expect(mocks.dismiss).toHaveBeenCalledWith('checkout-info-toast');
  await act(async () => {
    action.onClick();
  });
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
});

// Occupancy remains a write preflight rule, but no longer decorates or disables
// the option. The clicked branch must be named, with no mutation on rejection.
it('allows picking an occupied branch and reports its name only after preflight', async () => {
  const checkout = setupCheckout();
  checkout.mockImplementation(async (req) => ({
    status: {
      ...checkoutStatus,
      occupied: ['feature'],
      ...(req.branch === 'feature' ? { blocked: 'occupied' } : {}),
    },
  }));
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  await act(async () => {
    fireEvent.click(branchButton());
  });
  const option = await screen.findByRole('option', { name: 'feature' });
  expect(option.getAttribute('aria-disabled')).toBe('false');
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(option);
  });
  expect(mocks.toast).toHaveBeenCalledWith('newChat.checkout.errors.occupied{"branch":"feature"}');
  expect(branchButton().textContent).toBe('main');
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
});

// Toasts are reserved for information beyond the branch name itself, including
// the optional fetch count in newer host receipts. A plain/older receipt stays quiet.
it.each(['plain', 'carry', 'stash', 'idle', 'fetched'])(
  'only shows a success toast when checkout has extra information: %s',
  async (mode) => {
    const checkout = setupCheckout();
    let current = 'main';
    const hadChanges = mode === 'carry' || mode === 'stash';
    const target = mode === 'fetched' ? 'refs/remotes/origin/main' : 'feature';
    checkout.mockImplementation(async (req) => {
      if (req.action === 'switch') {
        const from = current;
        current = req.branch.replace(/^refs\/remotes\/origin\//, '');
        return {
          status: { ...checkoutStatus, current },
          receipt: {
            id: 'extra-info',
            from,
            to: current,
            strategy: req.strategy,
            hadChanges,
            sessions: mode === 'idle' ? [{ id: 'idle', name: 'Idle task', running: false }] : [],
            ...(mode === 'fetched' ? { fetchedCommits: 2 } : {}),
          },
        };
      }
      return { status: { ...checkoutStatus, current, files: hadChanges ? ['changed.txt'] : [] } };
    });
    render(<CheckoutRow />);
    await waitFor(() => expect(branchButton().textContent).toBe('main'));
    await act(async () => {
      fireEvent.click(branchButton());
    });
    await act(async () => {
      fireEvent.click(
        await screen.findByRole('option', {
          name: mode === 'fetched' ? 'origin/main' : target,
        }),
      );
    });
    if (hadChanges) {
      await screen.findByRole('dialog');
      const choice =
        mode === 'stash'
          ? 'newChat.checkout.stash{"branch":"main"}'
          : 'newChat.checkout.carry{"branch":"feature"}';
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: choice }));
      });
    }
    await waitFor(() =>
      expect(checkout.mock.calls.filter(([req]) => req.action === 'switch')).toHaveLength(1),
    );
    if (mode === 'plain') {
      expect(branchButton().textContent).toBe('feature');
      expect(mocks.success).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'newChat.checkout.undo' })).toBeNull();
    } else {
      const [message, options] = mocks.success.mock.calls.at(-1)!;
      const reason = {
        carry: 'carried',
        stash: 'stashed',
        idle: 'sessionsContinue',
        fetched: 'fetched',
      }[mode];
      expect(message).toContain(`newChat.checkout.${reason}`);
      if (mode === 'fetched') expect(message).toContain('"branch":"origin/main","count":2');
      expect(options.action.label).toBe('newChat.checkout.undo');
    }
  },
);

// Rule C: an unremembered worktree starts at the repository default, without
// persisting that default. Existing coverage only had a remembered feature source.
// Production row supplies the same derived value to creation. Tier: unit.
it.each([
  {
    remembered: '',
    remoteDefaultBranch: 'refs/remotes/origin/trunk',
    branches: ['main', 'master', 'feature'],
    expected: 'origin/trunk',
    source: 'refs/remotes/origin/trunk',
  },
  {
    remembered: 'remembered-source',
    remoteDefaultBranch: 'refs/remotes/origin/main',
    branches: ['main', 'feature'],
    expected: 'remembered-source',
    source: 'refs/remotes/origin/main',
  },
  { remembered: '', branches: ['main', 'master', 'feature'], expected: 'main', source: 'main' },
  { remembered: '', branches: ['master', 'feature'], expected: 'master', source: 'master' },
  { remembered: '', branches: ['feature'], expected: 'feature', source: 'feature' },
])(
  'uses the default source without saving it: $expected ($remembered)',
  async ({ remembered, remoteDefaultBranch, branches, expected, source }) => {
    setupCheckout(true, { current: 'feature' });
    vi.mocked(window.electronAPI.worktreeListBranches).mockResolvedValue({
      current: 'feature',
      branches,
      remoteDefaultBranch,
    });
    const onSourceChange = vi.fn();
    const defaultSource = vi.fn();
    render(
      <CheckoutRow
        remembered={remembered}
        onSourceChange={onSourceChange}
        defaultSource={defaultSource}
      />,
    );
    await waitFor(() => expect(branchButton().textContent).toBe('feature'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-agent-worktree-chip'));
    });
    await waitFor(() => expect(branchButton().textContent).toBe(expected));
    expect(defaultSource).toHaveBeenLastCalledWith({
      baseRepo: '/repo',
      deviceId: null,
      sourceBranch: source,
    });
    expect(onSourceChange).not.toHaveBeenCalled();
  },
);
