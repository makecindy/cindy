// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
const state = vi.hoisted(() => ({
  deviceId: undefined as string | undefined,
  openError: undefined as Error | undefined,
  openDeferred: undefined as Promise<{ viewId: string; prefersBorder: boolean }> | undefined,
  originListeners: new Set<() => void>(),
  controllers: [] as Array<{
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    displayMode: ReturnType<typeof vi.fn>;
    message: (message: { method: string; params?: Record<string, unknown> }) => void;
    fail: (error: unknown) => void;
    invoke: (session: string, input: Record<string, unknown>) => Promise<unknown>;
  }>,
  intersections: new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>(),
  windowHiddenListeners: new Set<(hidden: boolean) => void>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { title: string }) => key === 'mcpApps.cardTitle' ? values?.title : key,
  i18n: { language: 'en' },
}) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => state.deviceId }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {
  subscribe: (listener: () => void) => {
    state.originListeners.add(listener);
    return () => { state.originListeners.delete(listener); };
  },
} }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('../McpAppPermissionPrompt', () => ({ McpAppPermissionPrompt: () => null }));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => <span data-testid="spinner" /> }));
vi.mock('@cindy/maker-shared/mcp-app-controller', async importOriginal => ({
  ...await importOriginal<typeof import('@cindy/maker-shared/mcp-app-controller')>(),
  mcpAppFailureKey: () => 'mcpApps.loadFailed',
  McpAppController: class {
    open = vi.fn(async () => {
      if (state.openError) throw state.openError;
      if (state.openDeferred) return state.openDeferred;
      return { viewId: `view-${state.controllers.length}`, prefersBorder: true };
    });
    close = vi.fn(async () => {});
    context = vi.fn(async () => {});
    prepareNativeClose = vi.fn();
    displayMode = vi.fn(async (displayMode: string) => {
      this.message({ method: 'ui/notifications/host-context-changed', params: { displayMode } });
    });
    constructor(
      readonly invoke: (session: string, input: Record<string, unknown>) => Promise<unknown>,
      _session: string,
      _client: string,
      _post: unknown,
      readonly message: (message: { method: string; params?: Record<string, unknown> }) => void,
      readonly fail: (error: unknown) => void,
    ) { state.controllers.push(this); }
  },
}));
import { McpAppCard } from '../McpAppCard';
const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
const pendingDigests: Promise<ArrayBuffer>[] = [];
// The real presenter owns demand: no visible View means no state subscription;
// updates coalesce before IPC and leaving releases the source (unit).
it('subscribes only for a live View and coalesces context without reopening it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let changed = () => {};
  let revision = 1;
  const unsubscribe = vi.fn();
  const contextSource = { read: vi.fn(() => ({ draft: { revision } })),
    subscribe: vi.fn((callback: () => void) => { changed = callback; return unsubscribe; }) };
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="workspace" title="App" contextSource={contextSource} />));
    expect(contextSource.subscribe).not.toHaveBeenCalled();
    expect(contextSource.read).not.toHaveBeenCalled();
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    expect(contextSource.subscribe).toHaveBeenCalledOnce();
    const controller = state.controllers[0]; controller.context.mockClear(); contextSource.read.mockClear();
    await act(async () => { for (let i = 0; i < 100; i++) { revision++; changed(); } });
    expect(controller.context).toHaveBeenCalledOnce();
    expect(controller.context).toHaveBeenLastCalledWith(expect.objectContaining({ cindy: { draft: { revision: 101 } } }));
    expect(contextSource.read).toHaveBeenCalledOnce();
    expect(state.controllers).toHaveLength(1);
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    changed(); await Promise.resolve();
    expect(controller.context).toHaveBeenCalledOnce();
  } finally { if (container.hasChildNodes()) await act(async () => root.unmount()); container.remove(); }
});
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(webcrypto.subtle, 'digest').mockImplementation((...args) => {
    const pending = digest(...args);
    pendingDigests.push(pending);
    return pending;
  });
});
afterEach(async () => {
  // CI 41649027355: a prior card's asynchronous failure log can otherwise reach
  // the next test's electronAPI spy. Drain real hashing before replacing globals.
  await Promise.all(pendingDigests);
  pendingDigests.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.controllers = [];
  state.intersections.clear();
  state.deviceId = undefined;
  state.openError = undefined;
  state.openDeferred = undefined;
  state.originListeners.clear();
  state.windowHiddenListeners.clear();
  delete (window as Window & { __xdtHiddenAnimationGateLastHidden?: boolean }).__xdtHiddenAnimationGateLastHidden;
});

// Window visibility regression: document.visibilityState remains visible when
// Electron disables background throttling. The existing controller cleanup is
// the observable stop point for both local and remote cards.
it('treats a hidden main window as offscreen for local and remote cards, then rebuilds on restore', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('electronAPI', {
    onWindowHiddenChange: (callback: (hidden: boolean) => void) => {
      state.windowHiddenListeners.add(callback);
      return () => state.windowHiddenListeners.delete(callback);
    },
  });
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const hiddenWindow = window as Window & { __xdtHiddenAnimationGateLastHidden?: boolean };
  hiddenWindow.__xdtHiddenAnimationGateLastHidden = true;
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  state.deviceId = 'remote-device';
  try {
    await act(async () => root.render(<><McpAppCard sessionId={null} clientId="local-card" title="Local" />
      <McpAppCard sessionId="hidden-task" clientId="remote-card" title="Remote" /></>));
    const callbacks = [...state.intersections.values()];
    await act(async () => callbacks.forEach(callback => callback([{ isIntersecting: true }])));
    expect(state.controllers).toHaveLength(0);
    await act(async () => state.windowHiddenListeners.forEach(callback => callback(false)));
    expect(state.controllers).toHaveLength(2);
    const firstControllers = [...state.controllers];
    await act(async () => state.windowHiddenListeners.forEach(callback => callback(true)));
    expect(firstControllers.every(controller => controller.close.mock.calls.length === 1)).toBe(true);
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    await act(async () => state.windowHiddenListeners.forEach(callback => callback(false)));
    expect(state.controllers).toHaveLength(4);
    expect(container.querySelectorAll('iframe')).toHaveLength(2);
  } finally { hiddenWindow.__xdtHiddenAnimationGateLastHidden = undefined; await act(async () => root.unmount()); container.remove(); }
});

// 测试价值
// - 生产入口与结果：真实 McpAppCard iframe 生命周期；观察 opacity、pointer-events、aria-busy 和高度。
// - Bug／规则依据：PR-A 闪屏规划与 engineering-conventions §7/§8；旧卡片在重建时立即暴露空框。
// - 现有缺口：原有测试只验证 iframe 创建/销毁和高度回调，没有验证就绪前的可见性门。
// - 最小输入与 tier：一次初始化、结果标记、尺寸通知和 150ms 假时钟；renderer unit。
// PR-A readiness contract: the real card owns iframe visibility while the
// sandbox supplies host-owned handshake/result markers. This prevents an empty
// reconnect frame from being exposed without adding a second transport.
it('keeps a reconnecting iframe inert until initialization, result, and size are ready', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="reveal-task" clientId="reveal-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0]; const frame = container.querySelector('iframe')!;
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(frame.style.opacity).toBe('0'); expect(frame.style.pointerEvents).toBe('none');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(frame.style.opacity).toBe('0');
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 420 } }));
    expect(frame.style.opacity).toBe('1'); expect(frame.style.pointerEvents).toBe('auto');
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('shows delayed loading feedback for a slow open without flashing on a fast one', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let resolveOpen!: (document: { viewId: string; prefersBorder: boolean }) => void;
  state.openDeferred = new Promise(resolve => { resolveOpen = resolve; });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="loading-task" clientId="loading-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[data-testid="spinner"]')).not.toBeNull();
    resolveOpen({ viewId: 'delayed-view', prefersBorder: true });
    await act(async () => { await Promise.resolve(); });
    const controller = state.controllers[0];
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 400 } }));
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('removes delayed loading feedback when the open fails', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="error-loading-task" clientId="error-loading-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(container.querySelector('[data-testid="spinner"]')).not.toBeNull();
    await act(async () => state.controllers[0].fail(new Error('MCP_APP_FAILED')));
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('waits for a size change after result delivery instead of revealing on an earlier size', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="ordered-task" clientId="ordered-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0]; const frame = container.querySelector('iframe')!;
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 360 } }));
    await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    expect(frame.style.opacity).toBe('0'); expect(frame.style.pointerEvents).toBe('none');
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 380 } }));
    expect(frame.style.opacity).toBe('1'); expect(frame.style.pointerEvents).toBe('auto');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('reveals static pages quickly and enforces the total reveal deadline', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="static-task" clientId="static-card" title="Static" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const frame = container.querySelector('iframe')!;
    await act(async () => frame.dispatchEvent(new Event('load')));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(frame.style.opacity).toBe('1');
    await act(async () => root.render(<McpAppCard sessionId="deadline-task" clientId="deadline-card" title="Deadline" />));
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(container.querySelector('iframe')!.style.opacity).toBe('1');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('restores remembered heights and evicts the oldest cards at the cache limit', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    for (let index = 0; index <= 100; index++) {
      await act(async () => root.render(<McpAppCard sessionId="height-task" clientId={`height-${index}`} title="App" />));
      await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
      const controller = state.controllers.at(-1)!;
      await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
      await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
      await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 400 + index } }));
    }
    await act(async () => root.render(<McpAppCard sessionId="height-task" clientId="height-100" title="App" />));
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('500px');
    await act(async () => root.render(<McpAppCard sessionId="height-task" clientId="height-0" title="App" />));
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('320px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// Regression for Windows reconnects: a pre-result size is a transient loading
// layout and must not replace the remembered outer height or enter the cache.
it('keeps the remembered height through pre-result sizes and remembers the ready height', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="height-reconnect-task" clientId="height-reconnect-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const first = state.controllers[0];
    await act(async () => first.message({ method: 'ui/notifications/initialized' }));
    await act(async () => first.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(async () => first.message({ method: 'ui/notifications/size-changed', params: { height: 331 } }));
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('331px');
    await act(async () => root.render(null));
    state.intersections.clear();
    await act(async () => root.render(<McpAppCard sessionId="height-reconnect-task" clientId="height-reconnect-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const second = state.controllers[1];
    const frameRoot = container.querySelector('iframe')!.parentElement!;
    expect(frameRoot.style.height).toBe('331px');
    await act(async () => second.message({ method: 'ui/notifications/initialized' }));
    await act(async () => second.message({ method: 'ui/notifications/size-changed', params: { height: 320 } }));
    expect(frameRoot.style.height).toBe('331px');
    await act(async () => second.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(frameRoot.style.height).toBe('331px');
    await act(() => vi.advanceTimersByTimeAsync(210));
    await act(async () => second.message({ method: 'ui/notifications/size-changed', params: { height: 331 } }));
    expect(frameRoot.style.height).toBe('331px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('applies a pending height after reveal when no post-result size arrives', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="height-first-render-task" clientId="height-first-render-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    const frame = container.querySelector('iframe')!;
    const frameRoot = frame.parentElement!;
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 420 } }));
    expect(frameRoot.style.height).toBe('320px');
    await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(frameRoot.style.height).toBe('320px');
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(frameRoot.style.height).toBe('320px');
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(frameRoot.style.height).toBe('420px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('applies a real post-result height immediately and replaces the remembered value', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="height-post-result-task" clientId="height-post-result-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const first = state.controllers[0];
    await act(async () => first.message({ method: 'ui/notifications/initialized' }));
    await act(async () => first.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(async () => first.message({ method: 'ui/notifications/size-changed', params: { height: 331 } }));
    await act(async () => root.render(null));
    state.intersections.clear();
    await act(async () => root.render(<McpAppCard sessionId="height-post-result-task" clientId="height-post-result-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const second = state.controllers[1]; const frameRoot = container.querySelector('iframe')!.parentElement!;
    await act(async () => second.message({ method: 'ui/notifications/initialized' }));
    await act(async () => second.message({ method: 'ui/notifications/size-changed', params: { height: 320 } }));
    expect(frameRoot.style.height).toBe('331px');
    await act(async () => second.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    await act(async () => second.message({ method: 'ui/notifications/size-changed', params: { height: 280 } }));
    expect(frameRoot.style.height).toBe('280px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// A card without a tool result still uses initialized as its readiness gate.
it('applies initialized sizes immediately when no result is required', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId={null} clientId="height-no-result-card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0]; const frameRoot = container.querySelector('iframe')!.parentElement!;
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 410 } }));
    expect(frameRoot.style.height).toBe('410px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// #6432: the real card must release a mounted View without letting cleanup
// escape React. Existing jsdom tests lack moveBefore and close immediately.
// Unit tier models its connected-node constraint and delays close; the browser
// experiment separately verifies Chromium preserves the actual App document.
it.each(['unmount', 'failure-retry', 'disconnected', 'rejected-move', 'no-move-api'])(
  'finishes bounded View cleanup after %s', async (scenario) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(element: Element) { state.intersections.set(element, this.callback); }
      disconnect() {}
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const move = vi.fn((node: Node, child: Node | null) => {
      if (!node.isConnected || scenario === 'rejected-move')
        throw new DOMException('Atomic move requires a connected node', 'HierarchyRequestError');
      document.body.insertBefore(node, child);
    });
    Object.defineProperty(document.body, 'moveBefore', {
      configurable: true, value: scenario === 'no-move-api' ? undefined : move,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await act(async () => root.render(<article><div>
        <McpAppCard sessionId="task" clientId="card" title="App" fallbackText="Saved result" />
      </div></article>));
      await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
      const controller = state.controllers[0];
      controller.close.mockReturnValue(closed);
      const receive = added.mock.calls.find(([type]) => type === 'message')![1];
      const frame = container.querySelector('iframe')!;
      // The ancestor sandbox must also allow the inner App's submit event (G5).
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
      if (scenario === 'disconnected') frame.remove();
      if (scenario === 'failure-retry') {
        await act(async () => controller.fail(new Error('MCP_APP_FAILED')));
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        expect(container.textContent).toContain('Saved result');
        expect(frame.isConnected).toBe(true);
        await act(async () => container.querySelector('button')!.click());
        expect(state.controllers).toHaveLength(2);
        expect(container.querySelector('iframe')).not.toBe(frame);
        expect(container.querySelector('[role="alert"]')).toBeNull();
      } else {
        // Delete the ancestor message tree, as session switching/virtualization does.
        await act(async () => root.render(null));
      }
      expect(controller.close).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalledWith('message', receive);
      if (scenario === 'unmount' || scenario === 'failure-retry') {
        expect(frame.parentElement).toBe(document.body);
        expect(frame.isConnected).toBe(true);
      }
      if (scenario === 'disconnected') expect(move).not.toHaveBeenCalled();
      await act(async () => { finish(); await closed; });
      expect(frame.isConnected).toBe(false);
      expect(removed).toHaveBeenCalledWith('message', receive);
      if (scenario === 'failure-retry') {
        expect(container.querySelector('iframe')?.isConnected).toBe(true);
        expect(state.controllers[1].close).not.toHaveBeenCalled();
      }
    } finally {
      finish();
      await act(async () => root.unmount());
      container.remove();
      Reflect.deleteProperty(document.body, 'moveBefore');
    }
  },
);

it('reopens when device ownership is restored but ignores unchanged ownership', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const invoke = vi.fn(async () => ({}));
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const original = state.controllers[0];
    await act(async () => original.fail(new Error('MCP_APP_CARD_UNAVAILABLE')));
    await act(async () => {
      state.deviceId = 'restored-device';
      state.originListeners.forEach((listener) => listener());
    });
    expect(original.close).toHaveBeenCalledOnce();
    expect(state.controllers).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await state.controllers[1].invoke('task', { op: 'open', clientId: 'card' });
    expect(invoke).toHaveBeenLastCalledWith('task', { op: 'open', clientId: 'card', deviceId: 'restored-device' });
    await act(async () => state.originListeners.forEach((listener) => listener()));
    expect(state.controllers).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it.each([undefined, 'owner-device'])('releases offscreen history and opens visible owner cards on %s', async (deviceId) => {
  state.deviceId = deviceId;
  const invoke = vi.fn(async () => ({}));
  const generalInvoke = vi.fn();
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke }, deviceLink: { invoke: generalInvoke } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<>{Array.from({ length: 17 }, (_, i) =>
      <McpAppCard key={i} sessionId="task" clientId={`card-${i}`} title={`App ${i}`} />)}</>));
    expect(state.controllers).toHaveLength(0);
    const callbacks = [...state.intersections.values()];
    for (let i = 0; i < callbacks.length; i++) {
      await act(async () => {
        if (i) callbacks[i - 1]([{ isIntersecting: false }]);
        callbacks[i]([{ isIntersecting: true }]);
      });
      expect(state.controllers).toHaveLength(i + 1);
      expect(state.controllers.filter((controller) => controller.close.mock.calls.length === 0)).toHaveLength(1);
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      await state.controllers[i].invoke('task', { op: 'open', clientId: `card-${i}` });
      expect(invoke).toHaveBeenLastCalledWith('task', deviceId
        ? { op: 'open', clientId: `card-${i}`, deviceId } : { op: 'open', clientId: `card-${i}` });
      expect(generalInvoke).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect(state.controllers.every((controller) => controller.close.mock.calls.length === 1)).toBe(true);
});

it.each(['light', 'dark'])('shows saved text without mounting an interactive guest View in %s mode', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  state.deviceId = sharedTaskHostPeer('shared-task', 'host-device');
  const invoke = vi.fn();
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke }, deviceLink: { invoke } });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="card" title="Saved form"
      fallbackText="Saved result <script>window.attack=true</script>" />));
    expect(container.textContent).toContain('Saved form');
    expect(container.textContent).toContain('Saved result <script>window.attack=true</script>');
    expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
    expect(container.textContent).not.toContain('mcpApps.loadFailed');
    expect(container.querySelector('iframe, button, script')).toBeNull();
    expect(state.controllers).toHaveLength(0);
    expect(state.intersections.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="pending" title="Pending form" />));
    expect(container.textContent).toContain('Pending form');
    expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
  } finally {
    await act(async () => root.unmount());
    document.documentElement.classList.remove('dark');
  }
});

it.each(['light', 'dark'])('keeps saved text readable after App failures and retry in %s mode', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  state.openError = new Error('MCP_APP_SERVER_CHANGED');
  const saved = 'Saved result\n<script>window.attack=true</script>';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <McpAppCard sessionId="task" clientId="card" title="Saved form" fallbackText={saved} />,
    ));
    const [observed, intersect] = [...state.intersections.entries()][0];
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(container.textContent).toContain(saved);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('mcpApps.loadFailed');
    expect(container.querySelector('iframe, script')).toBeNull();
    // Retry must remain observable even after the empty iframe area collapses.
    expect(observed).toBe(container.querySelector('dialog'));
    state.openError = undefined;
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).not.toContain(saved);
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(state.controllers).toHaveLength(2);
    await act(async () => state.controllers[1].fail(new Error('offline')));
    expect(container.textContent).toContain(saved);
    expect(container.querySelector('iframe, script')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.classList.remove('dark');
  }
});

it.each(['light', 'dark'])('keeps the live App mounted while entering and leaving the native fullscreen modal in %s mode', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<><button>Opener</button>
      <McpAppCard sessionId="task" clientId="card" title="Live form" /></>));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const opener = container.querySelector('button')!;
    opener.focus();
    const dialog = container.querySelector('dialog')!;
    const frame = dialog.querySelector('iframe')!;
    const appWindow = frame.contentWindow;
    // JSDOM has no native modal/top-layer implementation; this suite covers
    // the retained document and controller lifecycle, not browser Tab traversal.
    const close = vi.fn(() => dialog.removeAttribute('open'));
    const showModal = vi.fn(() => dialog.setAttribute('open', ''));
    Object.defineProperties(dialog, { close: { value: close }, showModal: { value: showModal } });
    await act(async () => state.controllers[0].message({
      method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' },
    }));
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Live form');
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(dialog.querySelector('[data-exit-fullscreen]'));
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => { dialog.dispatchEvent(cancel); });
    expect(cancel.defaultPrevented).toBe(true);
    expect(state.controllers[0].displayMode).toHaveBeenCalledWith('inline');
    expect(dialog.getAttribute('role')).toBe('region');
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(dialog.querySelector('iframe')).toBe(frame);
    expect(frame.contentWindow).toBe(appWindow);
    expect(state.controllers).toHaveLength(1);
    expect(state.controllers[0].close).not.toHaveBeenCalled();
    await act(async () => state.controllers[0].message({
      method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' },
    }));
    await act(async () => state.controllers[0].fail(new Error('offline')));
    expect(document.activeElement).toBe(opener);
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.querySelector('iframe')).toBeNull();
    expect(close).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.classList.remove('dark');
  }
});

// unit: #7924 / 4422987779. The real card must follow incremental content growth
// without echoing height-only context; the old test misclassified eight growing
// notifications as feedback. Alternating sizes and the 5000px cap remain bounded.
it.each(['rising', 'oscillating'])('follows %s sizes without echoing height-only context or closing the View', async pattern => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  let resize!: () => void;
  let options: IntersectionObserverInit | undefined;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void, init?: IntersectionObserverInit) { options = init; }
    observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="card" title="App" />));
    expect(options?.rootMargin).toBe('80px 0px');
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    expect(controller.open).toHaveBeenCalledWith(expect.objectContaining({ containerDimensions: { width: 0, maxHeight: 5000 } }));
    await act(async () => controller.message({ method: 'ui/notifications/initialized' }));
    await act(async () => controller.message({ method: 'ui/notifications/sandbox-result-delivered' }));
    for (let i = 0; i < 10; i++) await act(async () => {
      controller.message({ method: 'ui/notifications/size-changed', params: { height: pattern === 'rising' ? 400 + i * 30 : 400 + (i % 2) * 30 } }); resize();
    });
    expect(controller.context).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe(pattern === 'rising' ? '670px' : '400px');
    if (pattern === 'rising') {
      await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 350 } }));
      expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('350px');
    }
    expect(controller.close).not.toHaveBeenCalled();
    const frameRoot = container.querySelector('iframe')!.parentElement!;
    Object.defineProperty(frameRoot, 'clientWidth', { configurable: true, value: 500 });
    await act(async () => resize());
    expect(controller.context).toHaveBeenCalledTimes(1);
    await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 7000 } }));
    expect(frameRoot.style.height).toBe('5000px');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// M05, unit: the public IPC failure must render a limitation, not a broken App.
// The remote IPC entry/Host round-trip is covered in main/mcp-apps/ipc.test.ts.
it.each(['light', 'dark'])('shows the remote local-files placeholder in %s mode', async mode => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.documentElement.classList.toggle('dark', mode === 'dark');
  state.deviceId = 'execution-computer';
  state.openError = new Error("Error invoking remote method 'maker:mcp-apps:v1': Error: [PRECONDITION_FAILED] MCP_APP_FILES_LOCAL_ONLY");
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="files" title="Report" fallbackText="Saved report" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    expect(container.textContent).toContain('mcpApps.filesOnExecutionComputer');
    expect(container.textContent).toContain('Saved report');
    expect(container.textContent).not.toContain('mcpApps.loadFailed');
    expect(container.querySelector('iframe')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); document.documentElement.classList.remove('dark'); }
});

// Unit regression: demo 5 showed only “load failed”, with no diagnostic in Main.
// Existing card tests check UI/cleanup, not the real renderer→Main log boundary.
// Minimum failure: a lifecycle error containing a code plus HTML, arguments, result
// and a credential-bearing URL. Only a fixed code/stage and hashed card may cross IPC.
it.each([
  ['open', 'MCP_APP_FILES_LOCAL_ONLY'],
  ['sandbox', 'MCP_APP_SANDBOX_FAILED'],
  ['initialize', 'MCP_APP_INITIALIZATION_FAILED'],
  ['timeout', 'MCP_APP_INITIALIZATION_TIMEOUT'],
  ['open', 'UNKNOWN'],
] as const)('logs a content-free %s failure (%s) through the renderer logger', async (stage, code) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const logToMain = vi.fn();
  vi.stubGlobal('electronAPI', { logToMain });
  const error = new Error(`[PRECONDITION_FAILED] ${code === 'UNKNOWN' ? 'MCP_APP_PRIVATE_PAYLOAD' : code} <html>PRIVATE_HTML</html> args=PRIVATE_INPUT result=PRIVATE_RESULT https://private.invalid/?token=PRIVATE_TOKEN`);
  if (stage === 'open') state.openError = error;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="PRIVATE_SESSION" clientId="PRIVATE_CARD" title="PRIVATE_TITLE" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    if (stage !== 'open') await act(async () => {
      if (stage === 'initialize') container.querySelector('iframe')!.dispatchEvent(new Event('load'));
      state.controllers[0].fail(error);
      state.controllers[0].fail(error); // Cleanup must prevent duplicate logging.
    });
    await vi.waitFor(() => expect(logToMain).toHaveBeenCalledOnce());
    const [level, scope, text] = logToMain.mock.calls[0];
    expect([level, scope]).toEqual(['warn', 'mcp-apps']);
    expect(text).toContain('App View failed');
    expect(text).toContain(`"code":"${code}"`);
    expect(text).toContain(`"stage":"${stage}"`);
    expect(text).toMatch(/"card":"[a-f0-9]{12}"/);
    expect(text).not.toMatch(/PRIVATE|https:|<html>|args=|result=|Error:|stack/i);
    expect(container.textContent).toContain(code === 'MCP_APP_FILES_LOCAL_ONLY' ? 'mcpApps.filesOnExecutionComputer' : 'mcpApps.loadFailed');
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
