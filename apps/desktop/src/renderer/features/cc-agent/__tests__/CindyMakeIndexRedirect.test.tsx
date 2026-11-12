// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { CCAgentIndexRedirect } from '../CCAgentIndexRedirect';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { clearLastView, saveLastChatView } from '../lib/lastViewStore';

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  isLoading: false,
  navigate: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: state.sessions, isLoading: state.isLoading }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: vi.fn(),
  orcaWorkflowsFor: () => ({ getByWorkerSession: state.getWorkflow }),
}));
afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
  clearLastView();
});
beforeEach(() => {
  state.sessions = [];
  state.isLoading = false;
  state.navigate.mockReset();
  state.getWorkflow.mockReset().mockResolvedValue(null);
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPinnedOriginsForTest();
  clearLastView();
  saveLastChatView({ kind: 'session', sessionId: 'make' });
});

/** Minimal active list row; URLs below are router paths, not filesystem paths. */
function task(id: string, extra: Partial<Session> = {}): Session {
  return { id, status: 'active', source: 'desktop', ...extra } as Session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<CCAgentIndexRedirect />);
  });
  return view;
}

function expectRoute(route: string) {
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith(
    route,
    route === '/cc-agent/new'
      ? { replace: true, state: { workspacePrompt: 'generic' } }
      : { replace: true },
  );
}

describe('startup after hiding Cindy Make', () => {
  it('skips the last Make task and hidden cached rows when restoring a task', async () => {
    state.sessions = [
      { id: 'make', source: 'cindy-make' },
      { id: 'merge', source: 'cindy-make-merge' },
      { id: 'ordinary', source: 'desktop' },
    ] as Session[];
    render(<CCAgentIndexRedirect />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith('/cc-agent/ordinary', { replace: true }),
    );
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });

  it('opens a draft when all cached tasks belong to Cindy Make', async () => {
    state.sessions = [{ id: 'make', source: 'cindy-make' }] as Session[];
    render(<CCAgentIndexRedirect />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith('/cc-agent/new', {
        replace: true,
        state: { workspacePrompt: 'generic' },
      }),
    );
    expect(state.navigate).toHaveBeenCalledTimes(1);
  });
});

/**
 * #7437 / unit: mount the real redirect with the real remote mirror and last-view
 * storage, asserting navigation. Existing cases only covered hidden Make rows.
 * Minimal failure: last=A exists only in the remote mirror, local list=[B].
 * Deferred workflow reads also expose cancellation during a mirror update.
 * Standalone run on Windows: 3.4s wall time (Vitest 1.63s, tests 115ms).
 */
describe('restoring tasks after Settings', () => {
  it.each([true, false])('restores remote A with local tasks=%s', async (hasLocal) => {
    state.sessions = hasLocal ? [task('B')] : [];
    remoteProjectsStore.setDeviceSessions('host', 'Host', [task('A')]);
    saveLastChatView({ kind: 'session', sessionId: 'A' });
    await mount();
    expectRoute('/cc-agent/A');
  });

  it('restores an offline remote snapshot instead of selecting a local task', async () => {
    state.sessions = [task('B')];
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'host', deviceName: 'Host', sessions: [task('A')] },
    ]);
    saveLastChatView({ kind: 'session', sessionId: 'A' });
    await mount();
    expectRoute('/cc-agent/A');
  });

  it.each(['archived', 'deleted', 'removed'] as const)(
    'falls back when remote A is %s',
    async (change) => {
      state.sessions = [task('B')];
      remoteProjectsStore.setDeviceSessions('host', 'Host', [task('A')]);
      if (change === 'removed') remoteProjectsStore.removeDevice('host');
      else remoteProjectsStore.applyPatch('host', 'A', { status: change });
      saveLastChatView({ kind: 'session', sessionId: 'A' });
      await mount();
      expectRoute('/cc-agent/B');
    },
  );

  it('excludes archived and non-task remote rows from default selection', async () => {
    remoteProjectsStore.setDeviceSessions('host', 'Host', [task('archived')], 'archived');
    remoteProjectsStore.mergeDeviceSessions('host', 'Host', [
      task('bot', { source: 'bot' }),
      task('side', { source: 'side-chat' }),
      task('make', { source: 'cindy-make' }),
      task('A'),
    ]);
    clearLastView();
    await mount();
    expectRoute('/cc-agent/A');
  });

  it.each(['new', 'local'] as const)('keeps the existing %s restoration priority', async (last) => {
    state.sessions = [task('B')];
    remoteProjectsStore.setDeviceSessions('host', 'Host', [task('A')]);
    saveLastChatView(last === 'new' ? { kind: 'new' } : { kind: 'session', sessionId: 'B' });
    await mount();
    expectRoute(last === 'new' ? '/cc-agent/new' : '/cc-agent/B');
  });

  it('waits for local loading before deciding that the last task is missing', async () => {
    state.isLoading = true;
    saveLastChatView({ kind: 'session', sessionId: 'B' });
    const view = await mount();
    expect(state.navigate).not.toHaveBeenCalled();
    state.sessions = [task('B')];
    state.isLoading = false;
    await act(async () => {
      view.rerender(<CCAgentIndexRedirect />);
    });
    expectRoute('/cc-agent/B');
  });

  it.each(['arrives', 'missing', 'failed'] as const)(
    'waits for an in-flight remote snapshot: %s',
    async (result) => {
      state.sessions = [task('B')];
      remoteProjectsStore.markBootstrapLoading('host');
      saveLastChatView({ kind: 'session', sessionId: 'A' });
      await mount();
      expect(state.navigate).not.toHaveBeenCalled();
      await act(async () => {
        if (result === 'failed') remoteProjectsStore.markBootstrapFailed('host');
        else
          remoteProjectsStore.setDeviceSessions(
            'host',
            'Host',
            result === 'arrives' ? [task('A')] : [],
          );
      });
      expectRoute(result === 'arrives' ? '/cc-agent/A' : '/cc-agent/B');
    },
  );

  it('does not wait for another device when the last task is already available', async () => {
    remoteProjectsStore.setDeviceSessions('host', 'Host', [task('A')]);
    remoteProjectsStore.markBootstrapLoading('other-host');
    saveLastChatView({ kind: 'session', sessionId: 'A' });
    await mount();
    expectRoute('/cc-agent/A');
  });

  it('waits only for the known origin, not another device still loading', async () => {
    state.sessions = [task('B')];
    remoteProjectsStore.pinSessionOrigin('host', 'A');
    remoteProjectsStore.markBootstrapLoading('host');
    remoteProjectsStore.markBootstrapLoading('other-host');
    saveLastChatView({ kind: 'session', sessionId: 'A' });
    await mount();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => {
      remoteProjectsStore.setDeviceSessions('host', 'Host', []);
    });
    expectRoute('/cc-agent/B');
  });

  it.each(['active', 'archived', 'missing'] as const)(
    'restores a remote Orca worker only with an active lead: %s',
    async (leadStatus) => {
      state.sessions = [task('B')];
      remoteProjectsStore.setDeviceSessions('host', 'Host', [
        task('worker', { orcaRole: 'worker' }),
      ]);
      if (leadStatus !== 'missing')
        remoteProjectsStore.mergeDeviceSessions(
          'host',
          'Host',
          [task('lead', { orcaRole: 'lead', status: leadStatus })],
          leadStatus,
        );
      state.getWorkflow.mockResolvedValue({ leadSessionId: 'lead' });
      saveLastChatView({ kind: 'session', sessionId: 'worker' });
      await mount();
      expectRoute(leadStatus === 'active' ? '/cc-agent/lead?worker=worker' : '/cc-agent/B');
    },
  );

  it('restarts a cancelled workflow lookup after a remote update and ignores its late result', async () => {
    const old = deferred<{ leadSessionId: string }>();
    remoteProjectsStore.setDeviceSessions('host', 'Host', [
      task('worker', { orcaRole: 'worker' }),
      task('lead', { orcaRole: 'lead' }),
    ]);
    saveLastChatView({ kind: 'session', sessionId: 'worker' });
    state.getWorkflow.mockReturnValueOnce(old.promise).mockResolvedValue({ leadSessionId: 'lead' });
    await mount();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => {
      remoteProjectsStore.applyPatch('host', 'worker', { title: 'Updated' });
    });
    expectRoute('/cc-agent/lead?worker=worker');
    await act(async () => {
      old.resolve({ leadSessionId: 'lead' });
    });
    expectRoute('/cc-agent/lead?worker=worker');
  });

  it('does not navigate after leaving the entry while a workflow lookup is pending', async () => {
    const pending = deferred<{ leadSessionId: string }>();
    state.sessions = [task('worker', { orcaRole: 'worker' }), task('lead', { orcaRole: 'lead' })];
    saveLastChatView({ kind: 'session', sessionId: 'worker' });
    state.getWorkflow.mockReturnValue(pending.promise);
    const view = await mount();
    view.unmount();
    await act(async () => {
      pending.resolve({ leadSessionId: 'lead' });
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('uses the new local fallback if the last worker disappears during its lookup', async () => {
    const old = deferred<{ leadSessionId: string }>();
    state.sessions = [task('worker', { orcaRole: 'worker' }), task('lead', { orcaRole: 'lead' })];
    saveLastChatView({ kind: 'session', sessionId: 'worker' });
    state.getWorkflow.mockReturnValue(old.promise);
    const view = await mount();
    state.sessions = [task('B')];
    await act(async () => {
      view.rerender(<CCAgentIndexRedirect />);
    });
    expectRoute('/cc-agent/B');
    await act(async () => {
      old.resolve({ leadSessionId: 'lead' });
    });
    expectRoute('/cc-agent/B');
  });

  it('survives StrictMode effect cancellation without getting stuck on loading', async () => {
    state.sessions = [task('B')];
    saveLastChatView({ kind: 'session', sessionId: 'B' });
    await act(async () => {
      render(
        <StrictMode>
          <CCAgentIndexRedirect />
        </StrictMode>,
      );
    });
    expectRoute('/cc-agent/B');
  });
});
