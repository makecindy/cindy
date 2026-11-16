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
import { BranchWorktreeChip, WorktreeChipsRow, type CheckoutBranchView } from '../WorktreeChipsRow';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { Tooltip } from '@/components/ui/tooltip';
const render = (element: React.ReactElement) =>
  rtlRender(element, {
    wrapper: ({ children }) => <Tooltip.Provider>{children}</Tooltip.Provider>,
  });
const mocks = vi.hoisted(() => ({
  running: new Map<string, { isRunning: boolean }>(),
  activityListeners: new Set<() => void>(),
  toast: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  update: vi.fn(),
  t: (key: string, args?: object) => key + (args ? JSON.stringify(args) : ''),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => mocks.running,
    subscribeAll: (listener: () => void) => {
      mocks.activityListeners.add(listener);
      return () => mocks.activityListeners.delete(listener);
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toast,
    warning: mocks.warning,
    success: mocks.success,
    info: mocks.info,
    dismiss: mocks.dismiss,
    update: mocks.update,
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  mocks.running.clear();
  mocks.activityListeners.clear();
  mocks.success.mockReturnValue('checkout-success-toast');
  mocks.info.mockReturnValue('checkout-info-toast');
  mocks.toast.mockReturnValue('checkout-error-toast');
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
  vi.unstubAllGlobals();
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
it.each(['transport', 'terminal', 'selection-change'] as const)(
  'retries after a %s failure with the correct operation identity',
  async (failure) => {
    const operationId = '8a7768e7-e652-4458-9c15-96af310bc9cb';
    let polls = 0;
    invoke.mockImplementation(async (_device, channel) => {
      if (channel !== 'worktree:sync-branch') return baseStatus;
      if (++polls === 1) return { pending: true, operationId };
      if (polls === 2)
        throw new Error(failure === 'terminal' ? 'branch-sync:changed' : 'connection lost');
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
      {
        baseRepo: '/repo',
        branch: failure === 'selection-change' ? 'next' : 'main',
        waitForResult: true,
        ...(failure === 'transport' ? { operationId } : {}),
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /newChat.branchSync.updated/ }));
    await waitFor(() => expect(polls).toBe(4));
    expect(
      invoke.mock.calls.filter((call) => call[1] === 'worktree:sync-branch')[3][2][0],
    ).not.toHaveProperty('operationId');
  },
);

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
// Regression: after separating the notices from the list viewport, locating a
// selected row must scroll only that viewport. Unit tier with simulated geometry;
// the browser fixture also checks real layout with main first and last.
it.each([false, true])(
  'keeps the current branch visible without moving notices (below=%s)',
  async (below) => {
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const top =
          this.getAttribute('role') === 'option' &&
          this.getAttribute('aria-selected') === 'true' &&
          below
            ? 300
            : 0;
        const height = this.getAttribute('role') === 'listbox' ? 200 : 30;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + height,
          left: 0,
          right: 280,
          width: 280,
          height,
          toJSON: () => ({}),
        };
      });
    try {
      render(
        <BranchWorktreeChip
          {...props}
          branches={below ? ['feature', 'main'] : ['main', 'feature']}
          remoteDefaultBranch={undefined}
          menuHeader={<p>Notice</p>}
        />,
      );
      await act(async () => {
        fireEvent.click(branchButton());
      });
      await waitFor(() => expect(screen.getByRole('listbox').scrollTop).toBe(below ? 130 : 0));
      expect(screen.getByText('Notice').getBoundingClientRect().top).toBe(0);
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      bounds.mockRestore();
    }
  },
);

// Regression: a late notice / Popover resize can clip the selected branch after
// the first animation frame. Unit tier; geometry changes after opening, then a
// user gesture must prevent the resize observer from taking over the scroll.
it.each(['wheel', 'search'])(
  'keeps the current branch visible after resize until %s',
  async (gesture) => {
    const callbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
          callbacks.add(this.callback);
        }
        unobserve() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
      },
    );
    let height = 200;
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const list = screen.queryByRole('listbox');
        const top =
          this.getAttribute('aria-selected') === 'true' ? 300 - (list?.scrollTop ?? 0) : 0;
        const h = this.getAttribute('role') === 'listbox' ? height : 30;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + h,
          left: 0,
          right: 280,
          width: 280,
          height: h,
          toJSON: () => ({}),
        };
      });
    const resize = () => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    };
    try {
      render(
        <BranchWorktreeChip
          {...props}
          branches={['feature', 'main']}
          remoteDefaultBranch={undefined}
        />,
      );
      fireEvent.click(branchButton());
      const list = await screen.findByRole('listbox');
      await waitFor(() => expect(list.scrollTop).toBe(130));
      height = 120;
      act(resize);
      await waitFor(() => expect(list.scrollTop).toBe(210));
      if (gesture === 'wheel') fireEvent.wheel(list, { deltaY: -60 });
      else fireEvent.change(screen.getByRole('combobox'), { target: { value: 'main' } });
      height = 80;
      act(resize);
      await act(async () => {
        await new Promise(requestAnimationFrame);
      });
      expect(list.scrollTop).toBe(210);
    } finally {
      cleanup();
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

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
it('offers origin sources and remote refresh while unchecked', async () => {
  render(<BranchWorktreeChip {...props} checked={false} />);
  await act(async () => {
    fireEvent.click(branchButton());
  });
  expect(screen.getByRole('group', { name: 'newChat.branchSync.remoteGroup' })).toBeTruthy();
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  await screen.findByRole('button', { name: /newChat.branchSync.updated/ });
  expect(sync).toHaveBeenCalled();
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
  branchView,
  cwd = '/repo',
}: {
  deviceId?: string;
  cwd?: string;
  onSourceChange?: (branch: string) => void;
  remembered?: string;
  defaultSource?: (value: { sourceBranch: string }) => void;
  branchView?: (value: CheckoutBranchView | null) => void;
} = {}) {
  const [enabled, setEnabled] = React.useState(false);
  const [source, setSource] = React.useState(remembered);
  return (
    <WorktreeChipsRow
      cwd={cwd}
      deviceLinkDeviceId={deviceId}
      enabled={enabled}
      onEnabledChange={setEnabled}
      sourceBranch={source}
      onDefaultSourceBranchChange={defaultSource}
      onCheckoutBranchViewChange={branchView}
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
it('keeps remote refresh available while worktree is off and disables it during checkout', async () => {
  const checkout = setupCheckout();
  render(<CheckoutRow />);
  await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(refreshButton());
  await screen.findByRole('button', { name: /newChat.branchSync.updated/ });
  expect(sync).toHaveBeenCalled();

  let resolve!: (reply: unknown) => void;
  checkout.mockImplementation(async (req) => {
    if (req.action === 'switch')
      return new Promise((done) => {
        resolve = done;
      });
    return { status: checkoutStatus };
  });
  await act(async () => {
    fireEvent.click(branchButton());
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  });
  await waitFor(() => expect(branchButton().getAttribute('aria-busy')).toBe('true'));
  expect(screen.getByRole('button', { name: /newChat.branchSync/ }).hasAttribute('disabled')).toBe(
    true,
  );
  await act(async () => resolve({ status: { ...checkoutStatus, current: 'feature' } }));
});
it('lazy-loads branches on menu open and does not refetch them on focus', async () => {
  const checkout = setupCheckout();
  const listBranches = vi.mocked(window.electronAPI.worktreeListBranches);
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  expect(listBranches).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(listBranches).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(branchButton());
  });
  await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(1));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(listBranches).toHaveBeenCalledTimes(1);
  expect(checkout).toHaveBeenCalled();
});
it('shows actual checkout when off and the remembered source when on; toggles never mutate Git', async () => {
  const checkout = setupCheckout();
  const branchView = vi.fn();
  render(<CheckoutRow branchView={branchView} />);
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
  // The explicit-start check must read the same OFF label and refresh that row
  // after an external checkout; source preference remains independent.
  expect(branchView.mock.lastCall?.[0]?.displayedBranch).toBe(branchButton().textContent);
  checkout.mockResolvedValue({ status: { ...checkoutStatus, current: 'feature' } });
  await act(async () => branchView.mock.lastCall?.[0]?.refresh());
  await waitFor(() => expect(branchButton().textContent).toBe('feature'));
  expect(branchView.mock.lastCall?.[0]?.displayedBranch).toBe('feature');
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
  expect(
    screen.getByText(mocks.t('newChat.checkout.runningTitle_one', { count: 1, name: 'Active' })),
  ).toBeTruthy();
  expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'newChat.checkout.startWorktree' }));
  });
  expect(screen.getByRole('listbox')).toBeTruthy();
  expect(branchButton().textContent).toBe('remembered-source');
  expect(mocks.info).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('checkbox', { name: 'newChat.worktree.toggleAria' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
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
  fireEvent.click(
    screen.getByRole('radio', { name: 'newChat.checkout.worktree{"branch":"main"}' }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'newChat.checkout.startWorktree' }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(branchButton().textContent).toBe('feature');
  expect(mocks.info).not.toHaveBeenCalled();
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
  const branchView = vi.fn();
  render(<CheckoutRow branchView={branchView} />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  expect(branchButton().getAttribute('aria-disabled')).toBe('true');
  expect(checkout).not.toHaveBeenCalled();
  // An explicit start can detect an external checkout even on a legacy host.
  // Refresh its label through detect-cwd, never the unsupported checkout channel.
  vi.mocked(window.electronAPI.worktreeDetectCwd).mockResolvedValue({
    isGitRepo: true,
    gitInstalled: true,
    isInsideWorktree: false,
    repoRoot: '/repo',
    currentBranch: 'feature',
    supportsCheckout: false,
  });
  await act(async () => branchView.mock.lastCall?.[0]?.refresh());
  await waitFor(() => expect(branchButton().textContent).toBe('feature'));
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

it.each(['unmount', 'directory'])(
  'dismisses the stale recovery toast after leaving via %s',
  async (mode) => {
    mocks.info.mockReturnValueOnce('checkout-info-toast').mockReturnValue('next-info-toast');
    const checkout = setupCheckout(true, { stashes: [{ id: 'saved', branch: 'main' }] });
    const view = render(<CheckoutRow />);
    await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
    const action = mocks.info.mock.calls[0][1].action;
    if (mode === 'unmount') view.unmount();
    else {
      window.electronAPI.worktreeDetectCwd = vi.fn().mockResolvedValue({
        isGitRepo: true,
        gitInstalled: true,
        isInsideWorktree: false,
        repoRoot: '/other',
        currentBranch: 'main',
        supportsCheckout: true,
      });
      await act(async () => {
        view.rerender(<CheckoutRow cwd="/other" />);
      });
      await waitFor(() => expect(mocks.info).toHaveBeenCalledTimes(2));
    }
    expect(mocks.dismiss).toHaveBeenCalledWith('checkout-info-toast');
    mocks.dismiss.mockClear();
    await act(async () => {
      action.onClick();
    });
    expect(mocks.dismiss).toHaveBeenCalledWith('checkout-info-toast');
    expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
  },
);

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

// Unit regression: an occupied-branch error must not linger over the next successful
// switch. Existing tests only checked the error itself, not its lifetime across picks.
it('dismisses the previous checkout error when another branch switch starts', async () => {
  const checkout = setupCheckout();
  let current = 'before';
  checkout.mockImplementation(async (req) => {
    if (req.action === 'switch') current = req.branch;
    return {
      status: {
        ...checkoutStatus,
        current,
        ...(req.branch === 'feature' ? { blocked: 'occupied' } : {}),
      },
    };
  });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('before'));
  fireEvent.click(branchButton());
  fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
  expect(mocks.dismiss).not.toHaveBeenCalledWith('checkout-error-toast');
  fireEvent.click(branchButton());
  fireEvent.click(await screen.findByRole('option', { name: 'main' }));
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  expect(mocks.dismiss).toHaveBeenCalledWith('checkout-error-toast');
  expect(mocks.toast).toHaveBeenCalledOnce();
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
        fireEvent.click(screen.getByRole('radio', { name: choice }));
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: `newChat.checkout.${mode === 'stash' ? 'stashConfirm' : 'carryConfirm'}`,
          }),
        );
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

// Redesign regression: selection has no Git side effect until explicit confirmation.
it.each([true, false])(
  'defaults dirty checkout to a usable choice (carry=%s)',
  async (carryAllowed) => {
    const checkout = setupCheckout(true, { files: ['file.txt'], carryAllowed });
    render(<CheckoutRow />);
    await waitFor(() => expect(branchButton().textContent).toBe('main'));
    fireEvent.click(branchButton());
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
    await screen.findByRole('dialog');
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0].checked).toBe(carryAllowed);
    expect(radios[0].disabled).toBe(!carryAllowed);
    expect(radios[1].checked).toBe(!carryAllowed);
    expect(checkout.mock.calls.every(([req]) => req.action === 'status')).toBe(true);
    fireEvent.click(
      screen.getByRole('button', {
        name: `newChat.checkout.${carryAllowed ? 'carryConfirm' : 'stashConfirm'}`,
      }),
    );
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'switch', strategy: carryAllowed ? 'carry' : 'stash' }),
      ),
    );
  },
);

// Busy is a menu-level reason, not a description duplicated on each branch.
it('places one busy notice outside the scrollable branch list', async () => {
  setupCheckout(true, { blocked: 'busy' });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  const option = await screen.findByRole('option', { name: 'feature' });
  expect(option.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getAllByText('newChat.checkout.errors.busy')).toHaveLength(1);
  expect(screen.getByRole('listbox').contains(screen.getByTestId('checkout-menu-notices'))).toBe(
    false,
  );
  expect(option.textContent).toBe('feature');
});

// A late sync-status response must not steal keyboard focus from notice actions.
// Unit tier, real row and delayed bridge response; covers the two surviving actions.
it.each(['busy', 'recover'])(
  'keeps keyboard focus on the %s notice action after refresh',
  async (kind) => {
    const checkout = setupCheckout(
      true,
      kind === 'busy'
        ? { blocked: 'busy', sessions: [{ id: 'running', name: 'Active', running: true }] }
        : { stashes: [{ id: 'saved', branch: 'main' }] },
    );
    render(<CheckoutRow />);
    await waitFor(() => expect(branchButton().textContent).toBe('main'));
    await waitFor(() => expect(refreshButton().hasAttribute('disabled')).toBe(false));
    let resolveStatus: (value: object) => void = () => {};
    status.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    fireEvent.click(branchButton());
    await screen.findByRole('option', { name: 'feature' });
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    const action = screen.getByRole('button', {
      name: kind === 'busy' ? 'newChat.checkout.startWorktree' : 'newChat.checkout.restore',
    });
    act(() => action.focus());
    await act(async () => {
      resolveStatus({ ...baseStatus, behind: 1 });
    });
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(document.activeElement).toBe(action);
    await act(async () => {
      fireEvent.click(action);
    });
    if (kind === 'busy')
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    else
      await waitFor(() =>
        expect(checkout).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'restore', stashId: 'saved' }),
        ),
      );
  },
);

it('explains the worktree checkbox with the shared short description', async () => {
  render(<BranchWorktreeChip {...props} />);
  fireEvent.focus(screen.getByRole('checkbox'));
  expect((await screen.findByRole('tooltip')).textContent).toBe('newChat.worktree.chipTooltip');
});

// Large dirty checkouts show a stable sample, not a scrollable full file list.
it('previews the first three of sixty changed files and reports the remainder', async () => {
  const files = Array.from({ length: 60 }, (_, i) => `file-${i}.txt`);
  setupCheckout(true, { files });
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'newChat.checkout.showFiles' }));
  await screen.findAllByRole('listitem');
  expect(screen.getAllByRole('listitem').map((row) => row.title)).toEqual(files.slice(0, 3));
  expect(screen.getByText(mocks.t('newChat.checkout.moreFiles', { count: 57 }))).toBeTruthy();
});

// Unit regression: a cached saved change may disappear before restore's authoritative
// reply. Existing stale-action tests only cover absence from the renderer cache.
it.each([
  ['main', 'savedMissing'],
  ['feature', 'restoreChanged'],
])('uses restore reply facts when the current branch is %s', async (current, error) => {
  const checkout = setupCheckout(true, { stashes: [{ id: 'saved', branch: 'main' }] });
  render(<CheckoutRow />);
  await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
  const action = mocks.info.mock.calls[0][1].action;
  checkout.mockClear();
  checkout.mockResolvedValue({ blocked: 'changed', status: { ...checkoutStatus, current } });
  await act(async () => {
    action.onClick();
  });
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(`newChat.checkout.errors.${error}`));
  expect(mocks.toast).toHaveBeenCalledOnce();
  expect(checkout.mock.calls.map(([req]) => req.action)).toEqual(['restore']);
  expect(checkout.mock.calls[0][0]).toEqual(
    expect.objectContaining({ expected: 'main', stashId: 'saved' }),
  );
  expect(mocks.dismiss).toHaveBeenCalledWith('checkout-info-toast');
  expect(mocks.success).not.toHaveBeenCalled();
});

// The same changed reply must retain undo guidance for an undo request.
it('keeps undo-specific guidance when undo is rejected after an external branch change', async () => {
  const checkout = setupCheckout();
  render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  await screen.findByRole('option', { name: 'feature' });
  checkout.mockResolvedValue({
    status: { ...checkoutStatus, current: 'feature' },
    receipt: {
      id: 'receipt',
      from: 'main',
      to: 'feature',
      strategy: 'carry',
      hadChanges: true,
      sessions: [],
    },
  });
  fireEvent.click(screen.getByRole('option', { name: 'feature' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
  checkout.mockResolvedValue({ blocked: 'changed', status: checkoutStatus });
  await act(async () => {
    mocks.success.mock.calls[0][1].action.onClick();
  });
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith('newChat.checkout.errors.undoChanged'),
  );
  expect(mocks.toast).toHaveBeenCalledOnce();
});

// Stale recovery actions must re-read facts once, then act or explain why not.
it.each([true, false, 'unknown'] as const)(
  'refreshes a stale restore action and gives visible feedback (available=%s)',
  async (available) => {
    const checkout = setupCheckout(true, { stashes: [{ id: 'saved', branch: 'main' }] });
    render(<CheckoutRow />);
    await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
    const action = mocks.info.mock.calls[0][1].action;
    if (available === 'unknown') checkout.mockRejectedValueOnce(new Error('offline'));
    else checkout.mockResolvedValue({ status: checkoutStatus });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('checkout-info-toast'));
    const before = checkout.mock.calls.length;
    checkout.mockImplementation(async (req) => ({
      status: {
        ...checkoutStatus,
        stashes: req.action === 'status' && available ? [{ id: 'saved', branch: 'main' }] : [],
      },
    }));
    await act(async () => {
      action.onClick();
    });
    await waitFor(() =>
      available
        ? expect(mocks.success).toHaveBeenCalledWith('newChat.checkout.restored')
        : expect(mocks.toast).toHaveBeenCalledWith('newChat.checkout.errors.savedMissing'),
    );
    expect(
      checkout.mock.calls.slice(before).filter(([req]) => req.action === 'status'),
    ).toHaveLength(1);
    expect(
      checkout.mock.calls.slice(before).filter(([req]) => req.action === 'restore'),
    ).toHaveLength(available ? 1 : 0);
  },
);

it('refreshes mismatched undo receipts, reports failure, and disables toast actions during a write', async () => {
  const checkout = setupCheckout();
  let current = 'main';
  let sequence = 0;
  let finish: (value: unknown) => void = () => {};
  checkout.mockImplementation(async (req) => {
    if (req.action === 'switch') {
      const from = current;
      current = req.branch;
      return {
        status: { ...checkoutStatus, current },
        receipt: {
          id: `receipt-${++sequence}`,
          from,
          to: current,
          strategy: 'carry',
          hadChanges: true,
          sessions: [],
        },
      };
    }
    if (req.action === 'undo')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { status: { ...checkoutStatus, current } };
  });
  const view = render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  for (const branch of ['feature', 'main']) {
    fireEvent.click(branchButton());
    fireEvent.click(await screen.findByRole('option', { name: branch }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(branch === 'feature' ? 1 : 2));
  }
  const oldAction = mocks.success.mock.calls[0][1].action;
  const action = mocks.success.mock.calls[1][1].action;
  const before = checkout.mock.calls.length;
  await act(async () => {
    oldAction.onClick();
  });
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith('newChat.checkout.errors.undoUnavailable'),
  );
  expect(checkout.mock.calls.slice(before).map(([req]) => req.action)).toEqual(['status']);
  await act(async () => {
    action.onClick();
  });
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(
      'checkout-success-toast',
      expect.any(String),
      expect.objectContaining({ action: expect.objectContaining({ disabled: true }) }),
    ),
  );
  expect(refreshButton().hasAttribute('disabled')).toBe(true);
  await act(async () => {
    action.onClick();
  });
  expect(checkout.mock.calls.filter(([req]) => req.action === 'undo')).toHaveLength(1);
  await act(async () => {
    finish({ status: checkoutStatus, undoApplied: true });
  });
  await waitFor(() => expect(mocks.success).toHaveBeenLastCalledWith('newChat.checkout.undone'));
  const afterUndo = checkout.mock.calls.length;
  await act(async () => {
    action.onClick();
  });
  await waitFor(() =>
    expect(checkout.mock.calls.slice(afterUndo).map(([req]) => req.action)).toEqual(['status']),
  );
  expect(mocks.toast).toHaveBeenLastCalledWith('newChat.checkout.errors.undoUnavailable');
  view.unmount();
  mocks.dismiss.mockClear();
  action.onClick();
  expect(mocks.dismiss).toHaveBeenCalledWith('checkout-success-toast');
});

it('disables the restore toast while its request is running', async () => {
  const checkout = setupCheckout(true, { stashes: [{ id: 'saved', branch: 'main' }] });
  render(<CheckoutRow />);
  await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
  const action = mocks.info.mock.calls[0][1].action;
  let finish: (value: unknown) => void = () => {};
  checkout.mockImplementation((req) =>
    req.action === 'restore'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ status: checkoutStatus }),
  );
  await act(async () => {
    action.onClick();
  });
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(
      'checkout-info-toast',
      expect.any(String),
      expect.objectContaining({ action: expect.objectContaining({ disabled: true }) }),
    ),
  );
  await act(async () => {
    action.onClick();
  });
  expect(checkout.mock.calls.filter(([req]) => req.action === 'restore')).toHaveLength(1);
  await act(async () => {
    finish({ status: checkoutStatus });
  });
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('newChat.checkout.restored'));
});

// Unit regression: an open busy menu used to remain stale after task completion.
// Drive the sidebar store notification through the real row; no polling or real waits.
it('refreshes an open checkout menu on relevant running edges and coalesces bursts', async () => {
  mocks.running.set('a', { isRunning: true });
  mocks.running.set('b', { isRunning: true });
  const checkout = setupCheckout(true, {
    blocked: 'busy',
    sessions: [
      { id: 'a', name: 'Active', running: true },
      { id: 'b', name: 'Other', running: true },
    ],
  });
  const view = render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  await screen.findByRole('button', { name: 'newChat.checkout.startWorktree' });
  const before = checkout.mock.calls.length;
  vi.useFakeTimers();
  try {
    const notify = () => mocks.activityListeners.forEach((listener) => listener());
    await act(async () => {
      mocks.running.set('unrelated', { isRunning: true });
      notify();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(checkout.mock.calls).toHaveLength(before);
    checkout.mockResolvedValue({
      status: {
        ...checkoutStatus,
        sessions: [
          { id: 'a', name: 'Active', running: false },
          { id: 'b', name: 'Other', running: false },
        ],
      },
    });
    await act(async () => {
      mocks.running.set('a', { isRunning: false });
      notify();
      mocks.running.set('b', { isRunning: false });
      notify();
      notify();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(checkout.mock.calls.slice(before).map(([req]) => req.action)).toEqual(['status']);
    expect(screen.queryByRole('button', { name: 'newChat.checkout.startWorktree' })).toBeNull();
    expect(screen.getByRole('option', { name: 'feature' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'newChat.checkout.useWorktree' })).toBeTruthy();
    checkout.mockResolvedValue({
      status: {
        ...checkoutStatus,
        blocked: 'busy',
        sessions: [
          { id: 'a', name: 'Active', running: true },
          { id: 'b', name: 'Other', running: true },
        ],
      },
    });
    await act(async () => {
      mocks.running.set('a', { isRunning: true });
      mocks.running.set('b', { isRunning: true });
      notify();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole('button', { name: 'newChat.checkout.startWorktree' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'feature' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    const beforeToggle = checkout.mock.calls.length;
    mocks.running.set('a', { isRunning: false });
    notify(); // A queued refresh is cancelled when worktree is enabled.
    fireEvent.click(screen.getByRole('checkbox', { name: 'newChat.worktree.toggleAria' }));
    expect(mocks.activityListeners.size).toBe(0);
    await act(async () => {
      notify();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(checkout.mock.calls).toHaveLength(beforeToggle);
    view.unmount();
    expect(mocks.activityListeners.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// Unit: remote task ids are scoped to their execution computer. An unrelated
// device completion must not cause a relay read or unblock this directory.
it('refreshes remote checkout status only for the matching device activity', async () => {
  clearRemoteSessionActivity();
  const checkout = setupCheckout(true, {
    blocked: 'busy',
    sessions: [{ id: 'a', name: 'Remote', running: true }],
  });
  invoke.mockImplementation(async (_device: string, channel: string, args: unknown[]) => {
    if (channel === 'worktree:checkout') return checkout(args[0]);
    if (channel === 'worktree:detect-cwd')
      return window.electronAPI.worktreeDetectCwd({ cwd: '/repo' });
    if (channel === 'worktree:list-branches')
      return window.electronAPI.worktreeListBranches({ baseRepo: '/repo' });
    if (channel === 'worktree:suggest-name') return { name: 'test' };
    if (channel === 'worktree:branch-sync-status') return baseStatus;
    return {};
  });
  applyRemoteSessionActivity('pc', { sessionId: 'a', phase: 'running' });
  const view = render(<CheckoutRow deviceId="pc" />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  await screen.findByRole('button', { name: 'newChat.checkout.startWorktree' });
  const before = checkout.mock.calls.length;
  vi.useFakeTimers();
  try {
    checkout.mockResolvedValue({
      status: { ...checkoutStatus, sessions: [{ id: 'a', name: 'Remote', running: false }] },
    });
    await act(async () => {
      applyRemoteSessionActivity('other', { sessionId: 'a', phase: 'completed', attention: true });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(checkout.mock.calls).toHaveLength(before);
    await act(async () => {
      applyRemoteSessionActivity('pc', { sessionId: 'a', phase: 'completed' });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(checkout.mock.calls.slice(before).map(([req]) => req.action)).toEqual(['status']);
    expect(screen.queryByRole('button', { name: 'newChat.checkout.startWorktree' })).toBeNull();
    expect(screen.getByRole('option', { name: 'feature' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  } finally {
    view.unmount();
    clearRemoteSessionActivity();
    vi.useRealTimers();
  }
});

// PR #10696 / unit: an already-started write survives unmount, reads do not.
it.each(['pending', 'lost-reply'])('stops result reads after unmount: %s', async (mode) => {
  const checkout = setupCheckout();
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  checkout.mockImplementation((req) =>
    req.action === 'switch'
      ? new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        })
      : Promise.resolve({ status: checkoutStatus }),
  );
  const view = render(<CheckoutRow />);
  await waitFor(() => expect(branchButton().textContent).toBe('main'));
  fireEvent.click(branchButton());
  fireEvent.click(await screen.findByRole('option', { name: 'feature' }));
  await waitFor(() => expect(finish).toBeDefined());
  const readsBeforeUnmount = checkout.mock.calls.length;
  view.unmount();
  await act(async () => {
    if (mode === 'pending') finish({ pending: true, operationId: 'original-write' });
    else fail(new Error('Lost reply'));
  });
  expect(checkout.mock.calls).toHaveLength(readsBeforeUnmount);
  expect(checkout.mock.calls.filter(([req]) => req.action === 'result')).toHaveLength(0);
  expect(checkout.mock.calls.filter(([req]) => req.action === 'switch')).toHaveLength(1);
});

// PR #10696: probe and chip must agree on detached/unborn HEAD, not a commit SHA.
it.each([{ current: 'abc123', head: 'abc123' }, { current: 'HEAD', head: '' }])(
  'publishes HEAD for an unnamed checkout %j', async (status) => {
    setupCheckout(true, status);
    const branchView = vi.fn();
    render(<CheckoutRow branchView={branchView} />);
    await waitFor(() => expect(branchButton().textContent).toBe('HEAD'));
    expect(branchView.mock.lastCall?.[0]?.displayedBranch).toBe('HEAD');
  },
);
