// @vitest-environment jsdom

/** WorktreeContext 只共享快照与 active 任务的探测结果；创建/回收按 sessionId 增量更新。 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorktreeProvider,
  useWorktrees,
  useRefreshWorktreeForSession,
  useReportWorktreeLiveness,
  useWorktreeForSession,
} from '@/contexts/WorktreeContext';
import { useTaskInfoWorktree } from '@/features/cc-agent/sidebar/sessionWorktreeInfo';
import { SessionInfoMeta } from '@/features/cc-agent/sidebar/SessionInfoMeta';
import { setDataOwnerGeneration, __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import { emitRefresh } from '@/lib/sessionsBus';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ fetchStatusesForSession: vi.fn() }),
  usePrStatus: () => undefined,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

const mocks = {
  getSession: vi.fn(),
  worktreeListAll: vi.fn(),
  worktreeGetForSession: vi.fn(),
  worktreeDetectCwd: vi.fn(),
  findLinkedWorktree: vi.fn(),
  recentGitDir: vi.fn(),
  listeners: new Set<(payload: { sessionId: string }) => void>(),
  sessionCreatedListeners: new Set<
    (payload: { sessionId: string }, ownerStamp?: unknown) => void
  >(),
  messageListeners: new Set<
    (payload: { sessionId: string; message: { role: string } }, ownerStamp?: unknown) => void
  >(),
};

function emitWorktreeChanged(sessionId: string): void {
  mocks.listeners.forEach((cb) => cb({ sessionId }));
}

function emitSessionCreated(sessionId: string, ownerStamp?: unknown): void {
  mocks.sessionCreatedListeners.forEach((cb) => cb({ sessionId }, ownerStamp));
}

function Probe() {
  const metas = useWorktrees();
  return (
    <span data-testid="ids">
      {Object.values(metas)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((meta) => `${meta.sessionId}:${meta.path}`)
        .join(',')}
    </span>
  );
}

function ActiveProbe() {
  const info = useTaskInfoWorktree({ id: 'open', workingDir: '/repo' }, true, {
    observeTelemetry: true,
  });
  return <span data-testid="active">{info?.path ?? ''}</span>;
}

function SidebarProbe({
  id = 'open',
  remoteHostId,
  deviceLinkDeviceId,
  enabled = true,
  onRender,
}: {
  id?: string;
  remoteHostId?: string;
  deviceLinkDeviceId?: string;
  enabled?: boolean;
  onRender?: () => void;
}) {
  const info = useTaskInfoWorktree(
    { id, workingDir: '/repo', remoteHostId, deviceLinkDeviceId },
    enabled,
  );
  onRender?.();
  return (
    <div data-testid={`sidebar-${id}`} data-path={info?.path ?? ''}>
      <SessionInfoMeta
        pieces={info ? [{ key: 'worktree', text: '' }] : []}
        worktree={info ?? undefined}
      />
    </div>
  );
}

function emitToolMessage(sessionId = 'open', role = 'tool_result', ownerStamp?: unknown) {
  mocks.messageListeners.forEach((cb) => cb({ sessionId, message: { role } }, ownerStamp));
}

beforeEach(() => {
  ownerTesting.reset();
  mocks.worktreeListAll.mockReset();
  mocks.worktreeGetForSession.mockReset();
  mocks.worktreeDetectCwd.mockReset();
  mocks.findLinkedWorktree.mockReset().mockResolvedValue(null);
  mocks.recentGitDir.mockReset().mockResolvedValue({ source: null, workdir: null, head: null });
  mocks.getSession.mockReset().mockImplementation(async (id: string) => ({ id }));
  mocks.worktreeDetectCwd.mockResolvedValue({
    isInsideWorktree: true,
    isGitRepo: true,
    gitInstalled: true,
  });
  mocks.listeners.clear();
  mocks.sessionCreatedListeners.clear();
  mocks.messageListeners.clear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeListAll: mocks.worktreeListAll,
      worktreeGetForSession: mocks.worktreeGetForSession,
      worktreeDetectCwd: mocks.worktreeDetectCwd,
      gitContext: {
        findLinkedWorktree: mocks.findLinkedWorktree,
        getForSession: mocks.recentGitDir,
      },
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
      localDb: {
        sessions: { get: mocks.getSession },
        messages: {
          onCreated: (
            cb: (
              payload: { sessionId: string; message: { role: string } },
              ownerStamp?: unknown,
            ) => void,
          ) => {
            mocks.messageListeners.add(cb);
            return () => mocks.messageListeners.delete(cb);
          },
        },
        sessionsPush: {
          onCreated: (cb: (payload: { sessionId: string }, ownerStamp?: unknown) => void) => {
            mocks.sessionCreatedListeners.add(cb);
            return () => mocks.sessionCreatedListeners.delete(cb);
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorktreeContext recycle refresh', () => {
  it('shows the real sidebar icon after a persisted tool result, shares it with the composer, and keeps it after switching tasks', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const content = (active: boolean) => (
      <WorktreeProvider>
        <Probe />
        <SidebarProbe />
        {active && <ActiveProbe />}
      </WorktreeProvider>
    );
    const view = render(content(true));
    await act(async () => {});
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();
    await act(async () => emitToolMessage('open', 'tool_use'));
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();

    mocks.recentGitDir.mockResolvedValue({
      source: 'telemetry',
      workdir: '/tmp/observed/open',
      head: { branch: 'feature' },
    });
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').querySelector('svg.lucide-folders')).not.toBeNull();
    expect(view.getByTestId('sidebar-open').querySelector('button')).toBeNull();
    expect(view.getByTestId('active').textContent).toBe('/tmp/observed/open');
    expect(view.getByTestId('ids').textContent).toBe(''); // never added to managed registry
    view.rerender(content(false));
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/observed/open');

    mocks.findLinkedWorktree.mockResolvedValue(null);
    view.rerender(content(true));
    await act(async () => {});
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();
    expect(view.getByTestId('active').textContent).toBe('');
  });

  it('updates a background list entry without opening it or scanning other rows', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/background', branch: null });
    const idleRender = vi.fn();
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
        <SidebarProbe id="idle" onRender={idleRender} />
      </WorktreeProvider>,
    );
    await act(async () => {});
    expect(mocks.findLinkedWorktree).not.toHaveBeenCalled();
    expect(mocks.messageListeners.size).toBe(1);
    idleRender.mockClear();
    await act(async () => emitToolMessage());
    expect(mocks.findLinkedWorktree).toHaveBeenCalledExactlyOnceWith({ sessionId: 'open' });
    expect(view.getByTestId('sidebar-open').querySelector('svg')).not.toBeNull();
    expect(view.getByTestId('sidebar-idle').querySelector('svg')).toBeNull();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
    expect(idleRender).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.messageListeners.size).toBe(0);
  });

  it('accepts current-owner messages, ignores stale-owner and non-tool pushes', async () => {
    setDataOwnerGeneration('owner', 3);
    mocks.worktreeListAll.mockResolvedValue([]);
    render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => {});
    await act(async () => {
      emitToolMessage('open', 'tool_result', { dataOwnerId: 'owner', ownerGeneration: 2 });
      emitToolMessage('open', 'assistant');
    });
    expect(mocks.findLinkedWorktree).not.toHaveBeenCalled();
    await act(async () =>
      emitToolMessage('open', 'tool_use', { dataOwnerId: 'owner', ownerGeneration: 3 }),
    );
    expect(mocks.findLinkedWorktree).toHaveBeenCalledOnce();
  });

  it('keeps managed entries cheap and removes an old observed fallback when that worktree is recycled', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/open', branch: null });
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/open');
    mocks.worktreeGetForSession.mockResolvedValue({ sessionId: 'open', path: '/tmp/open' });
    await act(async () => emitSessionCreated('open'));
    mocks.findLinkedWorktree.mockClear();
    await act(async () => emitToolMessage());
    expect(mocks.findLinkedWorktree).not.toHaveBeenCalled();
    mocks.worktreeGetForSession.mockResolvedValue(null);
    mocks.findLinkedWorktree.mockResolvedValue(null);
    await act(async () => emitWorktreeChanged('open'));
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();
    expect(mocks.findLinkedWorktree).toHaveBeenCalledExactlyOnceWith({ sessionId: 'open' });
  });

  it.each([{ remoteHostId: 'ssh' }, { deviceLinkDeviceId: 'remote' }])(
    'does not probe remote list entries: %j',
    async (remote) => {
      mocks.worktreeListAll.mockResolvedValue([]);
      mocks.getSession.mockResolvedValue({ id: 'open', ...remote });
      render(
        <WorktreeProvider>
          <SidebarProbe {...remote} />
        </WorktreeProvider>,
      );
      await act(async () => emitToolMessage());
      expect(mocks.findLinkedWorktree).not.toHaveBeenCalled();
    },
  );

  it('coalesces a burst during discovery and applies only the result after the newest tool write', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    let finish!: (value: unknown) => void;
    mocks.findLinkedWorktree
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ workdir: '/tmp/newest', branch: null });
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => {
      emitToolMessage();
      for (let i = 0; i < 10; i++) emitToolMessage();
      await Promise.resolve();
      finish({ workdir: '/tmp/stale', branch: null });
    });
    expect(mocks.findLinkedWorktree).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/newest');
    mocks.recentGitDir.mockRejectedValue(new Error('IPC unavailable'));
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/newest');
  });

  it('discovers with no mounted rows and while the field is disabled, then shows the cached icon', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/background', branch: null });
    const content = (visible: boolean, enabled = false) => (
      <WorktreeProvider>{visible && <SidebarProbe enabled={enabled} />}</WorktreeProvider>
    );
    const view = render(content(false));
    await act(async () => emitToolMessage());
    view.rerender(content(true));
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();
    mocks.recentGitDir.mockResolvedValue({
      source: 'telemetry',
      workdir: '/tmp/new-path',
      head: null,
    });
    await act(async () => emitToolMessage());
    view.rerender(content(true, true));
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/new-path');
    expect(view.getByTestId('sidebar-open').querySelector('svg.lucide-folders')).not.toBeNull();
    expect(mocks.findLinkedWorktree).toHaveBeenCalledOnce();
    expect(mocks.recentGitDir).toHaveBeenCalledOnce();
    expect(mocks.messageListeners.size).toBe(1);
  });

  it('bounds sequential tool refreshes for empty and observed tasks, follows new roots, and backfills only after invalidation', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    for (let i = 0; i < 40; i++) await act(async () => emitToolMessage());
    expect(mocks.findLinkedWorktree).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();

    // A fallback workingDir is never telemetry evidence.
    mocks.recentGitDir.mockResolvedValue({ source: 'workingDir', workdir: '/repo', head: null });
    await act(async () => emitToolMessage());
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
    mocks.recentGitDir.mockResolvedValue({
      source: 'telemetry',
      workdir: '/tmp/new/src',
      head: null,
    });
    mocks.worktreeDetectCwd.mockResolvedValue({
      isInsideWorktree: true,
      repoRoot: '/tmp/new',
      currentBranch: 'new',
    });
    for (let i = 0; i < 40; i++) await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/new');
    expect(mocks.findLinkedWorktree).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(40);

    // Returning to main does not forget an earlier live observed worktree.
    mocks.recentGitDir.mockResolvedValue({ source: 'telemetry', workdir: '/repo', head: null });
    mocks.worktreeDetectCwd.mockImplementation(async ({ cwd }) => ({
      isInsideWorktree: cwd === '/tmp/new',
    }));
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/new');
    expect(mocks.findLinkedWorktree).toHaveBeenCalledOnce();
    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/older', branch: null });
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/older');
    expect(mocks.findLinkedWorktree).toHaveBeenCalledTimes(2);
  });

  it('keeps a full-history invalidation queued behind a recent query and rejects probes after unmount', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/old', branch: null });
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => emitToolMessage());
    let finish!: (value: unknown) => void;
    mocks.recentGitDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => emitToolMessage());
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/older', branch: null });
    await act(async () => {
      emitWorktreeChanged('open');
      finish({ source: 'telemetry', workdir: '/tmp/recent', head: null });
    });
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/older');
    expect(mocks.findLinkedWorktree).toHaveBeenCalledTimes(2);
    mocks.recentGitDir.mockResolvedValue({
      source: 'telemetry',
      workdir: '/tmp/pending',
      head: null,
    });
    mocks.worktreeDetectCwd.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => emitToolMessage());
    view.unmount();
    await act(async () => finish({ isInsideWorktree: false }));
    expect(mocks.findLinkedWorktree).toHaveBeenCalledTimes(2);
  });

  it('starts a new history backfill for a different owner even after an empty snapshot', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => emitToolMessage());
    setDataOwnerGeneration('next-owner');
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/next-owner', branch: null });
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/next-owner');
    expect(mocks.findLinkedWorktree).toHaveBeenCalledTimes(2);
  });

  it('retains accepted snapshots across same-owner recommits but rejects old-generation pending results', async () => {
    setDataOwnerGeneration('owner', 1);
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/accepted', branch: null });
    const content = () => (
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>
    );
    const view = render(content());
    await act(async () => emitToolMessage());
    let finish!: (value: unknown) => void;
    mocks.recentGitDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => emitToolMessage());
    setDataOwnerGeneration('owner', 2);
    view.rerender(content());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/accepted');
    await act(async () => finish({ source: 'telemetry', workdir: '/tmp/stale', head: null }));
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/accepted');
    mocks.findLinkedWorktree.mockResolvedValue(null);
    await act(async () => emitWorktreeChanged('open'));
    expect(view.getByTestId('sidebar-open').querySelector('svg')).toBeNull();
  });

  it('does not probe a missing session or continue a session lookup after owner change or unmount', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.getSession.mockResolvedValueOnce(null);
    const view = render(
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>,
    );
    await act(async () => emitToolMessage());
    let finish!: (value: unknown) => void;
    mocks.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => emitToolMessage());
    setDataOwnerGeneration('different-owner');
    await act(async () => finish({ id: 'open' }));
    await act(async () => emitToolMessage());
    view.unmount();
    await act(async () => finish({ id: 'open' }));
    expect(mocks.findLinkedWorktree).not.toHaveBeenCalled();
  });

  it('does not attach a late discovery to a different task or owner', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    let finish!: (value: unknown) => void;
    mocks.findLinkedWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const content = (id: string) => (
      <WorktreeProvider>
        <SidebarProbe id={id} />
      </WorktreeProvider>
    );
    const view = render(content('open'));
    await act(async () => emitToolMessage());
    view.rerender(content('other'));
    await act(async () => finish({ workdir: '/tmp/open', branch: null }));
    expect(view.getByTestId('sidebar-other').getAttribute('data-path')).toBe('');
    await act(async () => emitToolMessage('other'));
    setDataOwnerGeneration('replacement-owner');
    await act(async () => finish({ workdir: '/tmp/old-owner', branch: null }));
    expect(view.getByTestId('sidebar-other').getAttribute('data-path')).toBe('');
  });

  it('hides the previous owner snapshot and lets the new owner refresh while an old request is pending', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/owner-a', branch: null });
    const content = () => (
      <WorktreeProvider>
        <SidebarProbe />
      </WorktreeProvider>
    );
    const view = render(content());
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/owner-a');
    let finishOld!: (value: unknown) => void;
    mocks.recentGitDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    await act(async () => emitToolMessage());
    setDataOwnerGeneration('owner-b');
    view.rerender(content());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('');
    mocks.findLinkedWorktree.mockResolvedValue({ workdir: '/tmp/owner-b', branch: null });
    await act(async () => emitToolMessage());
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/owner-b');
    await act(async () =>
      finishOld({ source: 'telemetry', workdir: '/tmp/old-owner-late', head: null }),
    );
    expect(view.getByTestId('sidebar-open').getAttribute('data-path')).toBe('/tmp/owner-b');
  });

  it('shares external deletion with sidebar badges, retains metadata for reopening and detects external restoration', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta, { sessionId: 'idle', path: '/tmp/wt/idle' }]);
    const content = (active: boolean) => (
      <WorktreeProvider>
        <Probe />
        {active && <ActiveProbe />}
      </WorktreeProvider>
    );
    const view = render(content(true));
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe(meta.path);

    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(view.getByTestId('active').textContent).toBe('');
    expect(view.getByTestId('ids').textContent).toBe('idle:/tmp/wt/idle');

    view.rerender(content(false));
    mocks.worktreeDetectCwd.mockClear().mockResolvedValue({ isInsideWorktree: true });
    view.rerender(content(true));
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe(meta.path);
    expect(view.getByTestId('ids').textContent).toContain('open:/tmp/wt/open');
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledExactlyOnceWith({ cwd: meta.path });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
  });

  it('rechecks same-path restoration through refreshSession without requiring a changed push or focus', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta]);
    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      refresh = useRefreshWorktreeForSession();
      return (
        <>
          <Probe />
          <ActiveProbe />
        </>
      );
    }
    const view = render(
      <WorktreeProvider>
        <Actions />
      </WorktreeProvider>,
    );
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe('');
    expect(view.getByTestId('ids').textContent).toBe('');

    mocks.worktreeGetForSession.mockResolvedValue({ ...meta });
    mocks.worktreeDetectCwd.mockClear().mockResolvedValue({ isInsideWorktree: true });
    await act(async () => {
      await refresh('open');
    });
    expect(view.getByTestId('active').textContent).toBe(meta.path);
    expect(view.getByTestId('ids').textContent).toBe(`open:${meta.path}`);
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledExactlyOnceWith({ cwd: meta.path });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not hide a live worktree when its probe rejects', async () => {
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'open', path: '/tmp/wt/open' }]);
    const view = render(
      <WorktreeProvider>
        <Probe />
        <ActiveProbe />
      </WorktreeProvider>,
    );
    await act(async () => {});
    mocks.worktreeDetectCwd.mockRejectedValue(new Error('probe timeout'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(view.getByTestId('active').textContent).toBe('/tmp/wt/open');
    expect(view.getByTestId('ids').textContent).toBe('open:/tmp/wt/open');
  });

  it.each(['/tmp/wt/open', '/tmp/wt/restored'])(
    'uses replacement metadata at %s while its probe is pending or fails, ignoring old results',
    async (restoredPath) => {
      const meta = { sessionId: 'open', path: '/tmp/wt/open' };
      mocks.worktreeListAll.mockResolvedValue([meta]);
      mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
      let refresh!: (sessionId: string) => Promise<void>;
      function Actions() {
        refresh = useRefreshWorktreeForSession();
        return (
          <>
            <Probe />
            <ActiveProbe />
          </>
        );
      }
      const view = render(
        <WorktreeProvider>
          <Actions />
        </WorktreeProvider>,
      );
      await act(async () => {});
      expect(view.getByTestId('active').textContent).toBe('');
      expect(view.getByTestId('ids').textContent).toBe('');

      let finishOld!: (value: { isInsideWorktree: boolean }) => void;
      mocks.worktreeDetectCwd.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      let rejectNew!: (reason: Error) => void;
      mocks.worktreeGetForSession.mockResolvedValue({ ...meta, path: restoredPath });
      mocks.worktreeDetectCwd.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectNew = reject;
          }),
      );
      await act(async () => {
        await refresh('open');
      });
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(mocks.worktreeDetectCwd).toHaveBeenLastCalledWith({ cwd: restoredPath });

      await act(async () => {
        finishOld({ isInsideWorktree: false });
      });
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);
      await act(async () => {
        rejectNew(new Error('[INTERNAL] Worktree directory probe failed'));
      });
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);

      // A conclusive result for the new metadata must still update both views.
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(view.getByTestId('active').textContent).toBe('');
      expect(view.getByTestId('ids').textContent).toBe('');
      expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);
      expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
      expect(mocks.worktreeGetForSession).toHaveBeenCalledExactlyOnceWith('open');
    },
  );

  it('ignores liveness reports captured before same-path restoration or recycling', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta]);
    let report!: ReturnType<typeof useReportWorktreeLiveness>;
    let original!: NonNullable<ReturnType<typeof useWorktreeForSession>>;
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      report = useReportWorktreeLiveness();
      original = useWorktreeForSession('open') ?? original;
      refresh = useRefreshWorktreeForSession();
      return <Probe />;
    }
    const view = render(
      <WorktreeProvider>
        <Actions />
      </WorktreeProvider>,
    );
    await act(async () => {});
    const oldMeta = original;
    mocks.worktreeGetForSession.mockResolvedValue({ ...meta });
    await act(async () => {
      await refresh('open');
    });
    await act(async () => {
      report(oldMeta, false);
    });
    expect(view.getByTestId('ids').textContent).toBe('open:/tmp/wt/open');
    mocks.worktreeGetForSession.mockResolvedValue(null);
    await act(async () => {
      await refresh('open');
    });
    await act(async () => {
      report(original, true);
    });
    expect(view.getByTestId('ids').textContent).toBe('');
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('removes only the reported session without reloading the full snapshot', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'archived-one', path: '/tmp/wt/archived-one' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('archived-one:/tmp/wt/archived-one');
    });

    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    await act(async () => {
      emitWorktreeChanged('archived-one');
    });

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('other:/tmp/wt/other');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
  });

  it('updates only the reported worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'changed', path: '/tmp/wt/old' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'changed',
      path: '/tmp/wt/new',
    });

    act(() => emitWorktreeChanged('changed'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('changed:/tmp/wt/new');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest response when the same session changes twice', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([{ sessionId: 'same', path: '/tmp/wt/start' }]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessionId: 'same', path: '/tmp/wt/newest' });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/start'));

    act(() => {
      emitWorktreeChanged('same');
      emitWorktreeChanged('same');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/newest'));

    await act(async () => {
      resolveFirst({ sessionId: 'same', path: '/tmp/wt/stale' });
    });
    expect(view.getByTestId('ids').textContent).toBe('same:/tmp/wt/newest');
  });

  it('applies concurrent events for different sessions independently', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'first') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ sessionId, path: `/tmp/wt/${sessionId}` });
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitWorktreeChanged('first');
      emitWorktreeChanged('second');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('second'));
    await act(async () => {
      resolveFirst({ sessionId: 'first', path: '/tmp/wt/first' });
    });

    expect(view.getByTestId('ids').textContent).toBe('first:/tmp/wt/first,second:/tmp/wt/second');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not turn a sessions refresh into a worktree scan', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitRefresh());

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('discovers a worktree created by a local background session without scanning all worktrees', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'background',
      path: '/tmp/wt/background',
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('background'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('background:/tmp/wt/background');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('background');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not run Git validation for a local background session without a worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('notification-only'));

    await waitFor(() => {
      expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('notification-only');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('refreshes explicit creation, recycling and restoration repeatedly without a full scan', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      refresh = useRefreshWorktreeForSession();
      return <Probe />;
    }
    const view = render(
      <WorktreeProvider>
        <Actions />
      </WorktreeProvider>,
    );
    await act(async () => {});
    for (let i = 0; i < 3; i++) {
      mocks.worktreeGetForSession.mockResolvedValueOnce({
        sessionId: 'restored',
        path: `/tmp/wt/restored-${i}`,
      });
      await act(async () => {
        await refresh('restored');
      });
      expect(view.getByTestId('ids').textContent).toBe(`restored:/tmp/wt/restored-${i}`);
      mocks.worktreeGetForSession.mockResolvedValueOnce(null);
      await act(async () => {
        emitWorktreeChanged('restored');
      });
      expect(view.getByTestId('ids').textContent).toBe('');
    }
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeGetForSession).toHaveBeenCalledTimes(6);
  });

  it('ignores remote session creation pushes for the local worktree cache', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitSessionCreated('remote-collision', {
        dataOwnerId: 'owner',
        ownerGeneration: 1,
      });
    });

    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('loads idle worktree metadata without Git probes or a periodic full scan', async () => {
    vi.useFakeTimers();
    mocks.worktreeListAll.mockResolvedValue(
      Array.from({ length: 69 }, (_, i) => ({
        sessionId: `session-${i}`,
        path: `/tmp/wt/${i}`,
      })),
    );
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await act(async () => {});
    expect(view.getByTestId('ids').textContent).toContain('session-68:/tmp/wt/68');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('keeps creation and recycling events newer than a pending metadata snapshot', async () => {
    let finishList!: (value: Array<{ sessionId: string; path: string }>) => void;
    mocks.worktreeListAll.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );
    mocks.worktreeGetForSession.mockImplementation(async (sessionId: string) =>
      sessionId === 'new' ? { sessionId, path: '/tmp/wt/new' } : null,
    );
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await act(async () => {
      emitSessionCreated('new');
      emitWorktreeChanged('recycled');
    });
    await act(async () => {
      finishList([{ sessionId: 'recycled', path: '/tmp/wt/recycled' }]);
    });
    expect(view.getByTestId('ids').textContent).toBe('new:/tmp/wt/new');
  });

  it('unsubscribes on unmount so a later push cannot refresh a dead tree', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.sessionCreatedListeners.size).toBe(0);

    emitWorktreeChanged('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
  });

  it('still mounts when the push channel is unavailable', async () => {
    // 老 preload / 非 Electron 宿主下 onWorktreeChanged 可能缺失，不能让 Provider 崩。
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { worktreeListAll: mocks.worktreeListAll },
    });
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'only', path: '/tmp/wt/only' }]);

    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('only:/tmp/wt/only');
    });
  });
});
