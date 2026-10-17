// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate } from '../CindyMakeSessionGate';

const state = vi.hoisted(() => ({
  remote: [] as Array<{ id: string; source: string }>,
  localSource: undefined as string | undefined,
  getSession: vi.fn(),
  localListeners: new Set<() => void>(),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {
  subscribe: () => () => {}, getMergedRemoteSessions: () => state.remote,
} }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: {
  subscribe: (listener: () => void) => {
    state.localListeners.add(listener);
    return () => { state.localListeners.delete(listener); };
  },
  findById: () => state.localSource ? { source: state.localSource } : null,
} }));
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: state.getSession }));
afterEach(cleanup);
beforeEach(() => {
  state.remote = [];
  state.localSource = undefined;
  state.getSession.mockReset().mockResolvedValue(null);
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
