// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate } from '../CindyMakeSessionGate';
import { SessionRouteOriginGate } from '../SessionRouteOriginGate';
import { sideChatTaskRoute } from '../../right-sidebar/plugins/side-chat/state';
import { StrictMode } from 'react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const state = vi.hoisted(() => ({
  remote: [] as Array<{ id: string; source: string; model?: string; workingDir?: string }>,
  localSource: undefined as string | null | undefined,
  getSession: vi.fn(),
  localListeners: new Set<() => void>(),
  origins: new Map<string, string>(),
  readCurrent: true,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {
  subscribe: () => () => {}, getMergedRemoteSessions: () => state.remote,
  getSessionDeviceId: (id: string) => state.origins.get(id),
  pinSessionOrigin: (device: string, id: string) => { state.origins.set(id, device); },
  getDeviceSessions: () => state.remote,
  getDeviceName: () => 'Host',
  mergeDeviceSessions: (_device: string, _name: string, rows: typeof state.remote) => { state.remote = rows; },
  captureSessionRead: () => Object.assign(() => state.readCurrent, { mergeActivity: (value: unknown) => value }),
} }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: {
  subscribe: (listener: () => void) => {
    state.localListeners.add(listener);
    return () => { state.localListeners.delete(listener); };
  },
  findById: () => state.localSource !== undefined ? { source: state.localSource } : null,
} }));
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: state.getSession }));
afterEach(cleanup);
beforeEach(() => {
  state.remote = [];
  state.localSource = undefined;
  state.getSession.mockReset().mockResolvedValue(null);
  state.origins.clear();
  state.readCurrent = true;
});

it('opens a legacy cached task with null source instead of waiting forever', () => {
  state.localSource = null;
  render(<MemoryRouter><CindyMakeSessionGate sessionId="legacy"><div>Legacy task</div></CindyMakeSessionGate></MemoryRouter>);
  expect(screen.getByText('Legacy task')).toBeTruthy();
  expect(state.getSession).not.toHaveBeenCalled();
});

// Unit #6529: the old hidden-task tests only covered warm origins. A route
// surviving a renderer reload must pin its host before the first metadata read,
// even when no mirror has persisted. Exercise the production gates and router.
describe('remote task route origin', () => {
  function mountRoute(route: string, ownsWindowRoute = true, sessionId = 'child') {
    return render(<StrictMode><MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/cc-agent/:sessionId" element={
          <SessionRouteOriginGate sessionId={sessionId} ownsWindowRoute={ownsWindowRoute}>
            <CindyMakeSessionGate sessionId={sessionId}><div>Remote composer</div></CindyMakeSessionGate>
          </SessionRouteOriginGate>
        } />
        <Route path="/cc-agent" element={<div>Task list</div>} />
      </Routes>
    </MemoryRouter></StrictMode>);
  }

  it('recovers a hidden task from only the URL after losing all renderer origins', async () => {
    const route = sideChatTaskRoute('child', 'host/encoded');
    state.getSession.mockImplementation(async (id: string) => {
      if (state.origins.get(id) !== 'host/encoded') throw new Error('Local task not found');
      return { id, source: 'side-chat', model: 'model', workingDir: '/host/work' };
    });
    // Remount with the original URL and fresh memory, without a disk/list row.
    for (let reload = 0; reload < 2; reload++) {
      state.origins.clear();
      state.remote = [];
      const ui = mountRoute(route);
      await act(async () => {});
      expect(screen.getByText('Remote composer')).toBeTruthy();
      expect(state.getSession).toHaveBeenCalledWith('child');
      expect(state.remote).toEqual([{ id: 'child', source: 'side-chat', model: 'model', workingDir: '/host/work' }]);
      ui.unmount();
    }
  });

  it.each([null, new Error('offline')])('keeps a failed cold lookup out of the composer: %s', async result => {
    state.getSession.mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    await act(async () => { mountRoute(sideChatTaskRoute('child', 'host')); });
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('ccAgent.sessionEntry.back'));
    expect(screen.getByText('Task list')).toBeTruthy();
    expect(screen.queryByText('Remote composer')).toBeNull();
  });

  it('does not publish metadata after leaving the remote route', async () => {
    let resolve!: (value: unknown) => void;
    state.getSession.mockReturnValue(new Promise(done => { resolve = done; }));
    const ui = mountRoute(sideChatTaskRoute('child', 'host'));
    ui.unmount();
    await act(async () => resolve({ id: 'child', source: 'side-chat' }));
    expect(state.remote).toEqual([]);
  });

  it('keeps newer pushed metadata when a cold lookup finishes late', async () => {
    let resolve!: (value: unknown) => void;
    state.getSession.mockReturnValue(new Promise(done => { resolve = done; }));
    mountRoute(sideChatTaskRoute('child', 'host'));
    await act(async () => {
      state.readCurrent = false;
      state.remote = [{ id: 'child', source: 'side-chat', model: 'new-model' }];
      resolve({ id: 'child', source: 'side-chat', model: 'old-model' });
    });
    expect(screen.getByText('Remote composer')).toBeTruthy();
    expect(state.remote[0].model).toBe('new-model');
  });

  it('rejects a conflicting route host without reading or changing its known owner', async () => {
    state.origins.set('child', 'real-host');
    await act(async () => { mountRoute(sideChatTaskRoute('child', 'wrong-host')); });
    expect(screen.getByText('ccAgent.sessionEntry.denied')).toBeTruthy();
    expect(state.origins.get('child')).toBe('real-host');
    expect(state.getSession).not.toHaveBeenCalled();
    expect(screen.queryByText('Remote composer')).toBeNull();
  });

  it.each([
    { route: sideChatTaskRoute('child'), owns: true, id: 'child' },
    { route: sideChatTaskRoute('child', 'host'), owns: false, id: 'child' },
    { route: sideChatTaskRoute('parent', 'host'), owns: true, id: 'embedded' },
  ])('does not apply a host to local or embedded tasks: $route/$owns/$id', ({ route, owns, id }) => {
    state.localSource = 'desktop';
    mountRoute(route, owns, id);
    expect(screen.getByText('Remote composer')).toBeTruthy();
    expect(state.origins.size).toBe(0);
  });
});

function mount(child: React.ReactNode = <div>Composer</div>) {
  return render(<MemoryRouter initialEntries={['/old-task']}>
    <Routes>
      <Route path="/old-task" element={<CindyMakeSessionGate sessionId="old-task">{child}</CindyMakeSessionGate>} />
      <Route path="/cc-agent" element={<div>Task list</div>} />
    </Routes>
  </MemoryRouter>);
}

describe('old Cindy Make links', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('redirects a mirrored %s task before mounting its composer', (source) => {
    state.remote = [{ id: 'old-task', source }];
    const Composer = vi.fn(() => <div>Composer</div>);
    mount(<Composer />);
    expect(screen.getByText('Task list')).toBeTruthy();
    expect(Composer).not.toHaveBeenCalled();
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it('waits for metadata and redirects a hidden task missing from visible lists', async () => {
    let resolve!: (value: { id: string; source: string }) => void;
    state.getSession.mockReturnValue(new Promise(res => { resolve = res; }));
    const Composer = vi.fn(() => <div>Composer</div>);
    mount(<Composer />);
    expect(Composer).not.toHaveBeenCalled();
    await act(async () => resolve({ id: 'old-task', source: 'cindy-make' }));
    expect(screen.getByText('Task list')).toBeTruthy();
    expect(Composer).not.toHaveBeenCalled();
  });

  it('opens an ordinary cached task without an extra metadata request', () => {
    state.localSource = 'desktop';
    mount();
    expect(screen.getByText('Composer')).toBeTruthy();
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a rejected lookup', getSession: () => Promise.reject(new Error('offline')) },
    { label: 'a missing row', getSession: () => Promise.resolve(null) },
    { label: 'a mismatched row', getSession: () => Promise.resolve({ id: 'another-task', source: 'desktop' }) },
  ])('keeps the subtree unmounted after $label', async ({ getSession }) => {
    state.getSession.mockImplementation(getSession);
    const Composer = vi.fn(() => <div>Composer</div>);
    await act(async () => { mount(<Composer />); });
    expect(Composer).not.toHaveBeenCalled();
    expect(screen.queryByText('Task list')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByText('ccAgent.sessionEntry.back'));
    expect(screen.getByText('Task list')).toBeTruthy();
  });

  it.each([undefined, null, 'desktop'])('opens matching ordinary metadata with source %s', async (source) => {
    state.getSession.mockResolvedValue({ id: 'old-task', source });
    await act(async () => { mount(); });
    expect(screen.getByText('Composer')).toBeTruthy();
  });

  it.each(['desktop', 'cindy-make', 'cindy-make-merge'])('recovers from a failed lookup when the mirror confirms %s', async (source) => {
    state.getSession.mockRejectedValue(new Error('offline'));
    const Composer = vi.fn(() => <div>Composer</div>);
    await act(async () => { mount(<Composer />); });
    expect(Composer).not.toHaveBeenCalled();
    act(() => {
      state.localSource = source;
      for (const listener of state.localListeners) listener();
    });
    if (source === 'desktop') {
      expect(screen.getByText('Composer')).toBeTruthy();
    } else {
      expect(screen.getByText('Task list')).toBeTruthy();
      expect(Composer).not.toHaveBeenCalled();
    }
  });
});
