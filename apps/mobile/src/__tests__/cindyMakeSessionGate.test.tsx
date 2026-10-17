// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate, SESSION_ENTRY_LOOKUP_TIMEOUT_MS } from '@/session/CindyMakeSessionGate';
import type { NewSessionCreationTask } from '@/session/newSessionCreation';
import type { MainWindowAction } from '@/components/MobilePrimitives';

const state = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; source?: string; deviceLinkDeviceId?: string }>,
  listeners: new Set<() => void>(),
  maker: { getSession: vi.fn() },
  openLink: vi.fn(),
  unsubscribe: vi.fn(),
  connectionEpoch: 0,
  accountGeneration: 1,
  task: null as NewSessionCreationTask | null,
  router: { canGoBack: vi.fn(() => true), back: vi.fn(), replace: vi.fn() },
}));
vi.mock('@/session/newSessionCreation', () => ({
  useNewSessionCreationTask: () => state.task,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: Error) => error.message }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ActivityIndicator: () => createElement('span', { role: 'progressbar' }),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowEmptyState: ({ title, copy, children }: { title: string; copy: string; children?: ReactNode }) => createElement('section', {}, title, copy, children),
  MainWindowActionButton: ({ action }: { action: MainWindowAction }) => createElement('button', {
    'data-testid': action.testID, disabled: action.disabled || action.busy, onClick: action.onPress,
  }, action.label),
}));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessions: () => state.sessions,
  getSessionDeviceId: (sessionId: string) => state.sessions.find(session => session.id === sessionId)?.deviceLinkDeviceId,
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: state.accountGeneration }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  openLink: state.openLink,
  unsubscribe: state.unsubscribe,
  connectionEpoch: state.connectionEpoch,
}) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => state.maker }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => createElement('span', {}, `redirect:${href}`),
  useRouter: () => state.router,
}));

let root: Root;
let container: HTMLDivElement;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let originalActEnvironment: boolean | undefined;
beforeEach(() => {
  originalActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  state.sessions = [];
  state.maker.getSession.mockReset().mockResolvedValue(null);
  state.openLink.mockReset().mockResolvedValue(undefined);
  state.unsubscribe.mockReset().mockResolvedValue(undefined);
  state.connectionEpoch = 0;
  state.accountGeneration = 1;
  state.task = null;
  state.router.canGoBack.mockReset().mockReturnValue(true);
  state.router.back.mockReset();
  state.router.replace.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove(); state.listeners.clear();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

describe('mobile Cindy Make links', () => {
  const Content = vi.fn(() => createElement('span', {}, 'Composer'));
  const renderGate = () => act(async () => root.render(
    <CindyMakeSessionGate sessionId="new-task" deviceId="device-a" ownsSessionSubscription><Content /></CindyMakeSessionGate>,
  ));
  const click = (id: string) => act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(button).not.toBeNull();
    button!.click();
  });
  const failedCreation = (): NewSessionCreationTask => ({
    sessionId: 'new-task', deviceId: 'device-a', deviceName: 'PC', status: 'create-failed',
    startedAt: 1, phase: 'creating', error: 'REMOTE_AGENT_GROUP_UNAVAILABLE',
    firstMessageClientId: 'first-message', attachments: [],
    draft: { agentKind: 'codex', workspaceKind: 'dialogue', model: 'model', effort: 'medium',
      permissionMode: 'auto', workingDir: '', providerId: 'openai', fastMode: false, firstMessage: 'Keep my draft' },
  });

  it.each(['running', 'create-failed'] as const)('releases pipeline subscriptions when leaving the %s recovery page', async status => {
    state.task = { ...failedCreation(), status };
    await renderGate();
    expect(state.unsubscribe).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(state.unsubscribe).toHaveBeenCalledExactlyOnceWith(
      'session:new-task', 'device-a', ['sessions', 'session:new-task'],
    );
  });

  it('keeps subscriptions through the recovery-to-content handoff and releases them on exit', async () => {
    state.task = failedCreation();
    await renderGate();
    state.task = null;
    state.maker.getSession.mockResolvedValue({ id: 'new-task', source: 'desktop' });
    await renderGate();
    expect(container.textContent).toBe('Composer');
    expect(state.unsubscribe).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(state.unsubscribe).toHaveBeenCalledExactlyOnceWith(
      'session:new-task', 'device-a', ['sessions', 'session:new-task'],
    );
  });

  it('does not release the task route subscription when a file route using the gate exits', async () => {
    state.maker.getSession.mockResolvedValue({ id: 'new-task', source: 'desktop' });
    await act(async () => root.render(
      <CindyMakeSessionGate sessionId="new-task" deviceId="device-a"><Content /></CindyMakeSessionGate>,
    ));
    await act(async () => root.render(null));
    expect(state.unsubscribe).not.toHaveBeenCalled();
  });

  it('offers a manual metadata retry after an empty response without reconnecting', async () => {
    await renderGate();
    expect(container.textContent).toContain('session.entry.missing');
    expect(container.textContent).not.toContain('Composer');
    state.maker.getSession.mockResolvedValue({ id: 'new-task', source: 'desktop' });
    await click('session.entryRetry');
    expect(state.connectionEpoch).toBe(0);
    expect(state.maker.getSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Composer');
  });

  it.each(['memory', 'durable'] as const)('mounts the recovery owner for a prepared %s draft without a choice screen', async readyForEdit => {
    state.task = { ...failedCreation(), readyForEdit };
    await renderGate();
    await act(async () => root.render(null));
    await renderGate();
    expect(container.textContent).toBe('Composer');
    expect(container.querySelector('button')).toBeNull();
    expect(state.maker.getSession).not.toHaveBeenCalled();
  });

  it('shows link failures and returns home when a cold link has no back stack', async () => {
    state.openLink.mockRejectedValue(new Error('offline'));
    state.router.canGoBack.mockReturnValue(false);
    await renderGate();
    expect(container.textContent).toContain('session.entry.failed');
    expect(state.maker.getSession).not.toHaveBeenCalled();
    await click('session.entryBack');
    expect(state.router.replace).toHaveBeenCalledWith('/');
  });

  it.each(['link', 'metadata'])('times out a hanging %s read, ignores its late result and allows retry', async (stage) => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const pending = new Promise(r => { resolve = r; });
    if (stage === 'link') state.openLink.mockReturnValueOnce(pending);
    else state.maker.getSession.mockReturnValueOnce(pending);
    await renderGate();
    expect(container.textContent).toContain('session.entry.loading');
    await click('session.entryBack');
    expect(state.router.back).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(SESSION_ENTRY_LOOKUP_TIMEOUT_MS));
    expect(container.textContent).toContain('session.entry.timedOut');
    state.maker.getSession.mockResolvedValue({ id: 'new-task', source: 'desktop' });
    await click('session.entryRetry');
    expect(container.textContent).toBe('Composer');
    await act(async () => resolve({ id: 'new-task', source: 'cindy-make' }));
    expect(container.textContent).toBe('Composer');
  });

  it('ignores a pending response from the previous account', async () => {
    let resolve!: (value: unknown) => void;
    state.maker.getSession.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await renderGate();
    state.accountGeneration += 1;
    await renderGate();
    await act(async () => resolve({ id: 'new-task', source: 'desktop' }));
    expect(container.textContent).toContain('session.entry.missing');
    expect(container.textContent).not.toContain('Composer');
  });

  it('keeps confirmed content mounted while reconnecting without mirror metadata', async () => {
    state.maker.getSession.mockResolvedValueOnce({ id: 'new-task', source: 'desktop' });
    await renderGate();
    expect(container.textContent).toBe('Composer');
    state.connectionEpoch += 1;
    state.maker.getSession.mockReturnValueOnce(new Promise(() => {}));
    await renderGate();
    expect(container.textContent).toBe('Composer');
  });

  it.each(['pending', 'missing', 'failed', 'timeout'])('preserves mirror-confirmed content and its draft during a %s reconnect read', async result => {
    vi.useFakeTimers();
    const unmounted = vi.fn();
    const Composer = () => {
      useEffect(() => unmounted, []);
      return <input defaultValue="unsent draft" />;
    };
    const render = () => act(async () => root.render(
      <CindyMakeSessionGate sessionId="new-task" deviceId="device-a"><Composer /></CindyMakeSessionGate>,
    ));
    state.sessions = [{ id: 'new-task', deviceLinkDeviceId: 'device-a', source: 'desktop' }];
    await render();
    expect(state.maker.getSession).not.toHaveBeenCalled();
    const input = container.querySelector('input')!;
    input.value = 'draft edited before reconnect';
    state.sessions = [];
    state.connectionEpoch += 1;
    if (result === 'missing') state.maker.getSession.mockResolvedValue(null);
    else if (result === 'failed') state.maker.getSession.mockRejectedValue(new Error('offline'));
    else state.maker.getSession.mockReturnValue(new Promise(() => {}));
    await render();
    if (result === 'timeout') await act(async () => vi.advanceTimersByTime(SESSION_ENTRY_LOOKUP_TIMEOUT_MS));
    expect(unmounted).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft edited before reconnect');
  });

  it.each(['account', 'device', 'task'])('does not reuse a mirror confirmation after switching %s', async changed => {
    state.sessions = [{ id: 'new-task', deviceLinkDeviceId: 'device-a', source: 'desktop' }];
    await renderGate();
    expect(container.textContent).toBe('Composer');
    state.sessions = [];
    if (changed === 'account') state.accountGeneration += 1;
    state.maker.getSession.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(
      <CindyMakeSessionGate sessionId={changed === 'task' ? 'next-task' : 'new-task'}
        deviceId={changed === 'device' ? 'device-b' : 'device-a'} ownsSessionSubscription>
        <Content />
      </CindyMakeSessionGate>,
    ));
    expect(container.textContent).toContain('session.entry.loading');
    expect(container.textContent).not.toContain('Composer');
  });

  it('remembers a newer Make mirror source over an earlier ordinary lookup', async () => {
    state.maker.getSession.mockResolvedValue({ id: 'new-task', source: 'desktop' });
    await renderGate();
    expect(container.textContent).toBe('Composer');
    state.sessions = [{ id: 'new-task', deviceLinkDeviceId: 'device-a', source: 'cindy-make' }];
    await renderGate();
    expect(container.textContent).toBe('redirect:/');
    state.sessions = [];
    state.connectionEpoch += 1;
    state.maker.getSession.mockReturnValue(new Promise(() => {}));
    await renderGate();
    expect(container.textContent).toBe('redirect:/');
  });

  it.each(['running', 'create-failed'] as const)('keeps the optimistic task mounted during %s without remote metadata', async status => {
    state.task = { ...failedCreation(), status };
    state.sessions = [{ id: 'new-task', deviceLinkDeviceId: 'device-a' }];
    await renderGate();
    expect(container.textContent).toBe('Composer');
    expect(container.querySelector('button')).toBeNull();
    expect(state.maker.getSession).not.toHaveBeenCalled();
    state.connectionEpoch += 1;
    await renderGate();
    expect(container.textContent).toBe('Composer');
  });

  it('does not extend optimistic entry to file routes', async () => {
    state.task = { ...failedCreation(), status: 'running' };
    await act(async () => root.render(
      <CindyMakeSessionGate sessionId="new-task" deviceId="device-a"><span>Files</span></CindyMakeSessionGate>,
    ));
    expect(container.textContent).not.toContain('Files');
  });

  it('does not show another device creation recovery or bypass a known Make source', async () => {
    state.task = { ...failedCreation(), deviceId: 'device-b' };
    await renderGate();
    expect(container.textContent).not.toContain('Composer');
    state.task = failedCreation();
    state.sessions = [{ id: 'new-task', deviceLinkDeviceId: 'device-a', source: 'cindy-make' }];
    await renderGate();
    expect(container.textContent).toBe('redirect:/');
  });

  it('resolves mirrored tasks whose source is missing before mounting the screen', async () => {
    state.sessions = [{ id: 'old-task', deviceLinkDeviceId: 'device-a' }];
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.loading');
    expect(Content).not.toHaveBeenCalled();
    expect(state.maker.getSession).toHaveBeenCalledWith('old-task');
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toBe('Composer');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('redirects %s to Home before mounting the task screen', (source) => {
    state.sessions = [{ id: 'old-task', source }];
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it('waits for mirror metadata without mounting the task screen', () => {
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.failed');
    expect(Content).not.toHaveBeenCalled();
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'cindy-make' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('redirect:/');
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'desktop' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('Composer');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('resolves a cold %s link directly without waiting for the list', async (source) => {
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(state.openLink).toHaveBeenCalledWith('device-a');
    expect(state.maker.getSession).toHaveBeenCalledWith('old-task');
    expect(container.textContent).toContain('session.entry.loading');
    expect(Content).not.toHaveBeenCalled();
    await act(async () => resolveSession({ id: 'old-task', source }));
    expect(state.sessions).toEqual([]);
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it.each(['desktop', undefined])('opens an ordinary cold link only after confirming source %s', async (source) => {
    state.maker.getSession.mockResolvedValue({ id: 'old-task', source });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
  });

  it.each([null, { id: 'another-task', source: 'desktop' }])('keeps unresolved or mismatched metadata closed: %s', async (session) => {
    state.maker.getSession.mockResolvedValue(session);
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.missing');
    expect(Content).not.toHaveBeenCalled();
  });

  it('keeps a failed metadata lookup closed and retries after reconnecting', async () => {
    state.maker.getSession.mockRejectedValueOnce(new Error('metadata unavailable'));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    const gate = <CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>;
    await act(async () => root.render(gate));
    expect(container.textContent).toContain('session.entry.failed');
    expect(Content).not.toHaveBeenCalled();
    state.connectionEpoch += 1;
    state.maker.getSession.mockResolvedValue({ id: 'old-task', source: 'desktop' });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
    expect(state.maker.getSession).toHaveBeenCalledTimes(2);
  });

  it('ignores a late lookup after mirror metadata has identified a hidden task', async () => {
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'cindy-make', deviceLinkDeviceId: 'device-a' }];
      for (const listener of state.listeners) listener();
    });
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it('does not reuse confirmed metadata after switching tasks or accounts', async () => {
    state.maker.getSession.mockResolvedValueOnce({ id: 'old-task', source: 'desktop' });
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
    state.accountGeneration += 1;
    state.maker.getSession.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.loading');
    await act(async () => root.render(<CindyMakeSessionGate sessionId="next-task" deviceId="device-a"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.loading');
    expect(state.maker.getSession).toHaveBeenLastCalledWith('next-task');
  });

  it('does not use another device mirror or late response to unlock a switched route', async () => {
    state.sessions = [{ id: 'old-task', source: 'desktop', deviceLinkDeviceId: 'device-b' }];
    let resolveSession!: (session: { id: string; source: string }) => void;
    state.maker.getSession.mockReturnValueOnce(new Promise(resolve => { resolveSession = resolve; }))
      .mockReturnValueOnce(new Promise(() => {}));
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    await act(async () => root.render(<CindyMakeSessionGate sessionId="old-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toContain('session.entry.loading');
    await act(async () => root.render(<CindyMakeSessionGate sessionId="next-task" deviceId="device-a"><Content /></CindyMakeSessionGate>));
    await act(async () => resolveSession({ id: 'old-task', source: 'desktop' }));
    expect(container.textContent).toContain('session.entry.loading');
    expect(Content).not.toHaveBeenCalled();
  });
});
