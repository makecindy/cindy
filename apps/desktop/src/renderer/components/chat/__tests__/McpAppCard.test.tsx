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
    suspend: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
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
    document?: { viewId: string; prefersBorder: boolean };
    open = vi.fn(async () => {
      if (state.openError) throw state.openError;
      if (state.openDeferred) return state.openDeferred;
      return this.document = { viewId: `view-${state.controllers.length}`, prefersBorder: true };
    });
    close = vi.fn(async () => {});
    suspend = vi.fn(async () => {});
    resume = vi.fn(async () => {});
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
import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { useProportionalWidth } from '@/hooks/useProportionalWidth';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
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
  vi.useRealTimers();
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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
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
// Desktop history regression, unit: drop renderer modules but keep the profile storage.
it('restores the measured height before opening a historical card in a fresh renderer at a matching width', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let width = 400;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const props = { sessionId: 'history', clientId: 'height', title: 'Page' };
  try {
    setDataOwnerGeneration('layout-account');
    await act(async () => root.render(<McpAppCard {...props} />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const page = state.controllers.at(-1)!;
    // A same-account repair advances the generation while this card stays mounted.
    setDataOwnerGeneration('layout-account');
    await act(async () => {
      page.message({ method: 'ui/notifications/initialized' });
      page.message({ method: 'ui/notifications/sandbox-result-delivered' });
      page.message({ method: 'ui/notifications/size-changed', params: { height: 481 } });
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => root.render(null));
    // reset-modules: emulate a renderer restart while retaining the persisted profile cache.
    vi.resetModules();
    const { McpAppCard: FreshCard } = await import('../McpAppCard');
    const { setDataOwnerGeneration: signIn } = await import('@/contexts/dataOwnerGeneration');
    signIn('layout-account');
    width += 16;
    await act(async () => root.render(<FreshCard {...props} />));
    expect(container.querySelector('[style*="height: 481px"]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    await act(async () => root.render(null));
    width++;
    await act(async () => root.render(<FreshCard {...props} />));
    expect(container.querySelector('[style*="height: 320px"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); setDataOwnerGeneration(null);
  }
});

// Task reopen regression (unit): the session sets its message width in a parent
// layout effect. The fresh-renderer coverage above gives the card a stable width.
it('restores a page of historical cards at the settled message width before writing their heights', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  // jsdom has no layout. Model the measured 906px content before the session
  // applies its column width, and the content box inside the card's 1px border.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 920, 800));
  const heightsDuringSecondRead: string[] = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    const session = this.closest<HTMLElement>('[data-session]');
    if (this.parentElement?.getAttribute('aria-label') === 'B') {
      const first = session?.querySelector<HTMLElement>('dialog[aria-label="A"] > div:last-child');
      if (first) heightsDuringSecondRead.push(first.style.height);
    }
    const width = session?.style.getPropertyValue('--cindy-message-width');
    return width ? parseFloat(width) - 2 : 906;
  });
  function Session() {
    const { containerRef, messageWidth } = useProportionalWidth(914);
    return <div ref={containerRef} data-session=""><div style={{ maxWidth: messageWidth }}>
      <McpAppCard sessionId="task" clientId="a" title="A" />
      <McpAppCard sessionId="task" clientId="b" title="B" />
    </div></div>;
  }
  const account = 'width-on-reopen';
  const key = 'cindy.mcpAppHeights.v1.' + account;
  localStorage.setItem(key, JSON.stringify([
    [JSON.stringify([null, 'task', 'a']), 818, 446],
    [JSON.stringify([null, 'task', 'b']), 912, 476],
  ]));
  setDataOwnerGeneration(account);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Session />));
    // Reading B after committing A would force a second synchronous layout.
    expect(heightsDuringSecondRead).toContain('320px');
    expect(heightsDuringSecondRead).not.toContain('446px');
    const mounts = [...container.querySelectorAll<HTMLElement>('dialog > div:last-child')];
    expect(mounts.map(mount => mount.style.height)).toEqual(['446px', '320px']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    setDataOwnerGeneration(null);
    localStorage.removeItem(key);
  }
});

it('keeps the remembered height through pre-result sizes and remembers the ready height', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
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
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
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
      if (scenario === 'unmount') {
        await act(async () => {
          controller.message({ method: 'ui/notifications/initialized' });
          controller.message({ method: 'ui/notifications/sandbox-result-delivered' });
          controller.message({ method: 'ui/notifications/size-changed', params: { height: 294 } });
        });
        expect(frame.style.opacity).toBe('1');
        // jsdom has no layout. Supply the visible card's box before deleting its message tree.
        vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(32, 64, 640, 294));
      }
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
      if (scenario === 'unmount') {
        // While teardown is pending, keep the outgoing surface at its last size and hide it from input and paint.
        const style = getComputedStyle(frame);
        expect([style.width, style.height]).toEqual(['640px', '294px']);
        expect(style.opacity).toBe('0');
        expect(frame.inert).toBe(true);
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

// Unit through the real card lifecycle. Main can deliver an attachment the user
// requested while teardown is in flight; the listener used to stop at unmount,
// so the staged file reached no composer. Minimal failing input: one delivery
// after unmount and before close() settles.
it('keeps a composer delivery that crosses card teardown', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let deliver!: (payload: unknown) => void;
  const stop = vi.fn();
  vi.stubGlobal('electronAPI', { maker: { mcpApps: vi.fn(async () => ({})),
    onMcpAppComposerAttachment: (callback: typeof deliver) => { deliver = callback; return stop; } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await act(async () => root.render(<McpAppCard sessionId="teardown-task" clientId="card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    const viewId = (controller as unknown as { document: { viewId: string } }).document.viewId;
    controller.close.mockReturnValue(closed);
    await act(async () => root.render(null));
    expect(stop).not.toHaveBeenCalled();
    deliver({ sessionId: 'teardown-task', viewId, attachment: { id: 'late', mcpAppResourceKey: 'resource', name: 'late.txt',
      path: '/staged/late.txt', ext: '.txt', size: 1, category: 'text', mimeType: 'text/plain' } });
    expect(getDraft('teardown-task')?.attachments.map(file => file.name)).toEqual(['late.txt']);
    await act(async () => { finish(); await closed; });
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    finish();
    clearDraft('teardown-task');
    await act(async () => root.unmount());
    container.remove();
  }
});

// Unit through the real card lifecycle and owner-scoped draft store. The listener
// outlives unmount, so a delivery can land after an account switch and used to
// enter the new owner's draft of a shared task ID. Minimal failing input: owner
// a opens the card, the renderer switches to owner b, then the payload arrives.
it('drops a composer delivery that arrives after an account switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let deliver!: (payload: unknown) => void;
  const mcpApps = vi.fn(async () => ({}));
  vi.stubGlobal('electronAPI', { maker: { mcpApps,
    onMcpAppComposerAttachment: (callback: typeof deliver) => { deliver = callback; return () => {}; } } });
  setDataOwnerGeneration('owner-a');
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await act(async () => root.render(<McpAppCard sessionId="shared-task" clientId="card" title="App" />));
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    const viewId = (controller as unknown as { document: { viewId: string } }).document.viewId;
    controller.close.mockReturnValue(closed);
    await act(async () => root.render(null));
    setDataOwnerGeneration('owner-b');
    deliver({ sessionId: 'shared-task', viewId, attachment: { id: 'stale', mcpAppResourceKey: 'resource', name: 'stale.txt',
      path: '/owner-a/stale.txt', ext: '.txt', size: 1, category: 'text', mimeType: 'text/plain' } });
    expect(getDraft('shared-task')?.attachments ?? []).toEqual([]);
    deliver({ sessionId: 'shared-task', viewId, requestId: 'contains', resourceKey: 'resource' });
    expect(mcpApps).toHaveBeenLastCalledWith('shared-task', { op: 'host-result', requestId: 'contains', result: false });
  } finally {
    finish();
    clearDraft('shared-task');
    setDataOwnerGeneration(null);
    await act(async () => root.unmount());
    container.remove();
  }
});

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
it('keeps a local iframe through a short offscreen interval and resumes it without reopening', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    let changed = () => {};
    let version = 1;
    const contextSource = { read: vi.fn(() => ({ version })), subscribe: (callback: () => void) => { changed = callback; return () => {}; } };
    await act(async () => root.render(<McpAppCard sessionId="keep-task" clientId="keep-card" title="App" contextSource={contextSource} />));
    const callback = [...state.intersections.values()][0];
    await act(async () => callback([{ isIntersecting: true }]));
    const controller = state.controllers[0]; const frame = container.querySelector('iframe');
    controller.resume.mockClear();
    await act(async () => callback([{ isIntersecting: false }]));
    expect(controller.close).not.toHaveBeenCalled();
    expect(controller.suspend).toHaveBeenCalledOnce();
    contextSource.read.mockClear(); controller.context.mockClear();
    await act(async () => { version++; changed(); changed(); });
    expect(contextSource.read).not.toHaveBeenCalled();
    expect(controller.context).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    await act(async () => callback([{ isIntersecting: true }]));
    expect(state.controllers).toHaveLength(1);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(controller.resume).toHaveBeenCalledOnce();
    expect(contextSource.read).toHaveBeenCalledOnce();
    expect(controller.context).toHaveBeenLastCalledWith(expect.objectContaining({ cindy: { version: 2 } }));
    await act(async () => callback([{ isIntersecting: false }]));
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(controller.close).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('closes a local iframe after five seconds offscreen and rebuilds after return', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="expire-task" clientId="expire-card" title="App" />));
    const callback = [...state.intersections.values()][0];
    await act(async () => callback([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    await act(async () => callback([{ isIntersecting: false }]));
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(controller.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(controller.close).toHaveBeenCalledOnce();
    await act(async () => callback([{ isIntersecting: true }]));
    expect(state.controllers).toHaveLength(2);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('keeps at most two local offscreen views and evicts the oldest first', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<>{[0, 1, 2].map(index => <McpAppCard key={index} sessionId="evict-task" clientId={`evict-${index}`} title="App" />)}</>));
    const callbacks = [...state.intersections.values()];
    await act(async () => callbacks.forEach(callback => callback([{ isIntersecting: true }])));
    const controllers = [...state.controllers];
    await act(async () => callbacks.forEach(callback => callback([{ isIntersecting: false }])));
    expect(controllers[0].close).toHaveBeenCalledOnce();
    expect(controllers[1].close).not.toHaveBeenCalled();
    expect(controllers[2].close).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(controllers.every(controller => controller.close.mock.calls.length === 1)).toBe(true);
    expect(container.querySelector('iframe')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each(['owner-device'])('releases remote offscreen history immediately on %s', async (deviceId) => {
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
    expect(dialog.querySelector('[data-exit-fullscreen]')?.textContent).toBe('mcpApps.exitFullscreen');
    // #10625: host drops the request.
    const logToMain = vi.fn();
    vi.stubGlobal('electronAPI', { logToMain });
    state.controllers[0].displayMode.mockImplementationOnce(async () => { throw new Error('IPC_TIMEOUT'); });
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => { dialog.dispatchEvent(cancel); });
    expect(cancel.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(logToMain).toHaveBeenCalledOnce());
    expect(logToMain.mock.calls[0][2]).toContain('"stage":"exit-fullscreen"');
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
    await act(async () => state.controllers[0].message({ method: 'ui/notifications/sandbox-escape' }));
    expect(dialog.getAttribute('role')).toBe('region');
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
    expect(controller.open).toHaveBeenCalledWith(expect.objectContaining({ containerDimensions: { width: 0, maxHeight: 5000 } }), expect.any(Function));
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

// Card chrome / unit: real presenter, observed geometry and control requests.
// Legacy coverage never measured a fill surface or offered Host fullscreen.
it('fills a panel with nonzero dimensions and ignores App automatic heights without reopening', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  let resize!: () => void;
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="panel" clientId="fill" title="Page" chrome="panel" sizing="fill" />));
    const frameRoot = container.querySelector('[aria-busy]') ?? container.querySelector('dialog > div:last-child')!;
    let width = 600, height = 450;
    Object.defineProperty(frameRoot, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(frameRoot, 'clientHeight', { configurable: true, get: () => height });
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    expect(controller.open).toHaveBeenCalledWith(expect.objectContaining({ containerDimensions: { width: 600, height: 450 } }), expect.any(Function));
    expect(container.textContent).not.toContain('Page');
    for (let i = 0; i < 10; i++) await act(async () => controller.message({ method: 'ui/notifications/size-changed', params: { height: 800 + i * 100 } }));
    expect((frameRoot as HTMLElement).style.height).toBe('');
    height = 700;
    await act(async () => resize());
    expect(controller.context).toHaveBeenLastCalledWith(expect.objectContaining({ containerDimensions: { width: 600, height: 700 } }));
    const sent = controller.context.mock.calls.length;
    width = 0; height = 0;
    await act(async () => resize());
    expect(controller.context).toHaveBeenCalledTimes(sent);
    expect(controller.close).not.toHaveBeenCalled();
    expect(state.controllers).toHaveLength(1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([undefined, false, true])('offers fullscreen only after the Host explicitly permits its button (%s)', async allowed => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {} observe(element: Element) { state.intersections.set(element, this.callback); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="full" clientId="button" title="Planner" />));
    const dialog = container.querySelector('dialog')!; dialog.showModal = vi.fn(); dialog.close = vi.fn();
    await act(async () => [...state.intersections.values()][0]([{ isIntersecting: true }]));
    const controller = state.controllers[0];
    await act(async () => { controller.message({ method: 'ui/notifications/initialized' }); controller.message({ method: 'ui/notifications/sandbox-result-delivered' });
      controller.message({ method: 'ui/notifications/host-context-changed', params: allowed === undefined ? {} : { 'cindy/host-controls': { fullscreenButton: allowed } } }); });
    await act(() => vi.advanceTimersByTimeAsync(150));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="mcpApps.fullscreen"]');
    expect(Boolean(button)).toBe(allowed === true);
    if (button) { await act(async () => button.click()); expect(controller.displayMode).toHaveBeenCalledExactlyOnceWith('fullscreen'); }
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// The public snapshot, rather than title/name matching, decides exception labels.
// Minimal regression: a local plugin with the same name as a market plugin.
it.each([
  [undefined, undefined], [{ kind: 'market' }, undefined], [{ kind: 'organization' }, undefined],
  [{ kind: 'local' }, 'mcpApps.source.local'], [{ kind: 'new-source' }, 'mcpApps.source.unknown'],
])('renders source exceptions from the public card snapshot (%j)', async (source, warning) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="source" title="Planner · legacy title" plugin={{ name: 'Planner', ...(source ? { source } : {}) }} />));
    expect(container.textContent).toBe('Planner' + (warning ?? ''));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

// R3 / unit: production card title uses the snapshot, and old cards remain readable.
it.each([true, {}, { name: 42 }, { name: 'Team reports' }])('renders configured custom MCP names with a legacy fallback (%j)', async customMcp => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="custom" title="Tool title" customMcp={customMcp} />));
    expect(container.textContent).toBe((typeof customMcp === 'object' && customMcp.name === 'Team reports' ? 'Team reports' : 'Tool title') + 'mcpApps.customMcp');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
