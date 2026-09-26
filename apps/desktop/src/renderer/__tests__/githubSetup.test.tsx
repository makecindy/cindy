// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSetupDialog } from '../features/cc-agent/GithubSetupDialog';
import { GitContextBadge } from '../features/cc-agent/GitContextBadge';
import { Tooltip } from '../components/ui/tooltip';
import { PrRefsProvider, usePrActions, usePrStatus } from '../contexts/PrRefsContext';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'local-v1' }) }));
vi.mock('@/hooks/useSessionGitContext', () => ({
  useSessionGitContext: () => ({
    head: null,
    branchSource: null,
    prRefs: [
      { id: 'ref', owner: 'o', repo: 'r', prNumber: 1, url: 'https://github.com/o/r/pull/1' },
    ],
    prStatuses: new Map([['o/r#1', { ok: false, reason: 'gh-missing' }]]),
  }),
}));
afterEach(cleanup);
const key = 'ccAgent.gitContext.pr.setup';

describe('GitHub setup UI', () => {
  it('ignores outside clicks during authorization but still allows explicit cancellation', async () => {
    const close = vi.fn();
    const cancel = vi.fn(async () => ({ phase: 'cancelled' }));
    window.electronAPI = {
      gitContext: {
        githubSetupStatus: async () => ({ phase: 'authorizing', userCode: 'ABCD-1234' }),
        cancelGithubSetup: cancel,
      },
    } as any;
    render(<GithubSetupDialog onClose={close} />);
    await screen.findByText('ABCD-1234');
    // Radix installs its document pointer listener after mount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 });
    fireEvent.click(document.body);
    expect(close).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(`${key}.cancel`));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('opens setup from a missing-gh PR badge without depending on a composer', async () => {
    window.electronAPI = {
      gitContext: { githubSetupStatus: async () => ({ phase: 'idle' }) },
    } as any;
    render(
      <Tooltip.Provider>
        <GitContextBadge session={{ id: 'task' } as any} />
      </Tooltip.Provider>,
    );
    fireEvent.click(screen.getByText('#1'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(`${key}.install`)).toBeTruthy();
  });
  it('requires the connect action, shows the code and opens only GitHub device authorization', async () => {
    const start = vi.fn(async () => ({ phase: 'authorizing', userCode: 'ABCD-1234' }));
    const status = vi.fn(async () => ({ phase: 'idle' }));
    const openExternal = vi.fn();
    window.electronAPI = {
      gitContext: { githubSetupStatus: status, startGithubSetup: start },
      openExternal,
    } as any;
    render(<GithubSetupDialog onClose={() => {}} />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(start).not.toHaveBeenCalled();
    status.mockResolvedValue({ phase: 'authorizing', userCode: 'ABCD-1234' } as any);
    fireEvent.click(screen.getByText(`${key}.connect`));
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText(`${key}.openBrowser`));
    });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
  });

  it('uses the shared download meter and cancels before closing a running download', async () => {
    const close = vi.fn();
    const cancel = vi.fn(async () => ({ phase: 'cancelled' }));
    window.electronAPI = {
      gitContext: {
        githubSetupStatus: async () => ({ phase: 'downloading', percent: 42 }),
        cancelGithubSetup: cancel,
      },
    } as any;
    render(<GithubSetupDialog onClose={close} initialAction="install" />);
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('42');
    expect(document.querySelector('progress')).toBeNull();
    fireEvent.click(screen.getByText(`${key}.cancel`));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it('shows only Done after successful connection, and ignores stale success when reopened', async () => {
    const close = vi.fn();
    window.electronAPI = {
      gitContext: {
        githubSetupStatus: async () => ({ phase: 'connected' }),
        startGithubSetup: async () => ({ phase: 'connected' }),
      },
    } as any;
    render(<GithubSetupDialog onClose={close} />);
    expect(screen.queryByText(`${key}.done`)).toBeNull();
    fireEvent.click(screen.getByText(`${key}.connect`));
    fireEvent.click(await screen.findByText(`${key}.done`));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText(`${key}.cancel`)).toBeNull();
    expect(screen.queryByText(`${key}.connect`)).toBeNull();
  });

  it('keeps action failures visible and offers a retry', async () => {
    window.electronAPI = {
      gitContext: {
        githubSetupStatus: async () => ({ phase: 'idle' }),
        startGithubSetup: async () => {
          throw new Error('unavailable');
        },
      },
    } as any;
    render(<GithubSetupDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText(`${key}.connect`));
    expect(await screen.findByText(`${key}.stages.unavailable.title`)).toBeTruthy();
    expect(screen.getByText(`${key}.retry`)).toBeTruthy();
  });

  it('does not ask users to open GitHub until a device code is available', async () => {
    window.electronAPI = {
      gitContext: {
        githubSetupStatus: async () => ({ phase: 'authorizing' }),
      },
    } as any;
    render(<GithubSetupDialog onClose={() => {}} />);
    expect(await screen.findByText(`${key}.stages.preparing.title`)).toBeTruthy();
    expect(screen.queryByText(`${key}.openBrowser`)).toBeNull();
  });

  it('refreshes mounted PR consumers immediately and rejects a pre-login response', async () => {
    const ref = {
      id: 'ref',
      sessionId: 'task',
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      url: '',
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    let connected!: () => void;
    let finishOld!: (result: unknown[]) => void;
    const getPrStatuses = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue([
        {
          ...ref,
          ok: true,
          status: 'merged',
          title: 'Merged',
          branch: 'branch',
          htmlUrl: '',
          unresolvedCount: 0,
        },
      ]);
    window.electronAPI = {
      gitContext: {
        listAllPrRefs: async () => [ref],
        listPrRefs: async () => [ref],
        getPrStatuses,
        onPrRefsChanged: () => () => {},
        onGithubConnected: (cb: () => void) => {
          connected = cb;
          return () => {};
        },
      },
    } as any;
    function BadgeConsumer() {
      const { registerPrConsumer } = usePrActions();
      useEffect(() => registerPrConsumer('task'), [registerPrConsumer]);
      const status = usePrStatus('task', 'o/r#1');
      return <span>{status?.ok ? status.status : 'unknown'}</span>;
    }
    render(
      <PrRefsProvider>
        <BadgeConsumer />
      </PrRefsProvider>,
    );
    await waitFor(() => expect(getPrStatuses).toHaveBeenCalledOnce());
    act(() => connected());
    expect(await screen.findByText('merged')).toBeTruthy();
    await act(async () => finishOld([{ ...ref, ok: false, reason: 'gh-missing' }]));
    expect(screen.getByText('merged')).toBeTruthy();
  });
});
