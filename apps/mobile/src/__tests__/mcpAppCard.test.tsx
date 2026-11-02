// @vitest-environment jsdom
import { act, createElement, useEffect, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { Script } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { mcpAppSandboxDocument } from '@cindy/maker-shared/mcp-apps';
const state = vi.hoisted(() => ({
  props: {} as Record<string, any>,
  inject: vi.fn(),
  invoke: vi.fn(),
  mode: 'light',
  prepare: vi.fn(),
  random: 0,
  foreground: 'active',
  appStateListeners: new Set<(state: string) => void>(),
  surfaceAvailable: true,
  mounts: 0,
}));
vi.mock('../session/NativeMcpAppSurface', () => ({
  get mcpAppSurfaceAvailable() { return state.surfaceAvailable; },
  NativeMcpAppHost: ({ children, surfaceId }: any) => createElement('div', { 'data-host': surfaceId }, children),
  NativeMcpAppSlot: ({ surfaceId }: any) => createElement('div', { 'data-slot': surfaceId }),
}));
vi.mock('../session/mcpAppNativeDocument', () => ({ prepareMcpAppNativeDocument: state.prepare }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => null,
  Pressable: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: (_name: string, listener: (state: string) => void) => {
      state.appStateListeners.add(listener);
      return { remove: () => state.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock('react-native-webview', () => ({
  WebView: ({ ref, ...props }: any) => {
    state.props = props;
    useEffect(() => { ++state.mounts; }, []);
    useImperativeHandle(ref, () => ({ injectJavaScript: state.inject }));
    return createElement('div', { 'data-testid': 'mcp-webview' });
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(++state.random),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { title: string }) => key === 'mcpApps.cardTitle' ? values?.title : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ invoke: state.invoke }),
}));
vi.mock('@/theme', () => {
  const colors = {
    surface: 'white',
    surfaceElevated: 'white',
    textPrimary: 'black',
    textSecondary: 'gray',
    textTertiary: 'gray',
    border: 'gray',
  };
  return {
    useTheme: () => ({ colors, mode: state.mode }),
    textStyles: {},
    fontWeight: {},
    radius: {},
    spacing: {},
  };
});
import { McpAppCard } from '../session/McpAppCard';
import { McpAppViewsProvider } from '../session/McpAppViews';
const doc = {
  viewId: 'view',
  html: '<script>window.app=true</script>',
  csp: "default-src 'none'",
  prefersBorder: true,
  policy: { frameDomains: ['https://frame.example.org'] },
};
const nativeDocument = {
  source: { uri: 'http://127.0.0.1:5002/proxy.html' },
  resourceUrl: 'http://127.0.0.1:5001/resource.html',
  documentUrls: ['http://127.0.0.1:5002/proxy.html', 'http://127.0.0.1:5002/bootstrap',
    'http://127.0.0.1:5001/resource.html', 'http://127.0.0.1:5001/bootstrap'],
  close: async () => {},
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = (children: React.ReactNode) => root.render(<McpAppViewsProvider>{children}</McpAppViewsProvider>);
beforeEach(() => {
  vi.useFakeTimers();
  state.random = 0;
  state.mounts = 0;
  state.surfaceAvailable = true;
  state.appStateListeners.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.invoke.mockReset();
  state.inject.mockReset();
  state.props = {};
  state.mode = 'light';
  state.prepare.mockReset().mockResolvedValue(nativeDocument);
  state.invoke.mockImplementation(async (_device, _channel, [, input]) =>
    input.op === 'open' ? { ...doc } : input.op === 'poll' ? new Promise(() => {}) : {},
  );
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('binds a served resource origin and gates declared frame navigation', async () => {
  await act(async () =>
    render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />),
  );
  expect(state.props.originWhitelist).toEqual(['*']);
  const allow = state.props.onShouldStartLoadWithRequest;
  expect(allow({ isTopFrame: false, url: 'https://frame.example.org/embed' })).toBe(true);
  expect(allow({ isTopFrame: false, url: 'https://other.example.org/embed' })).toBe(false);
  expect(allow({ isTopFrame: true, url: 'https://frame.example.org/embed' })).toBe(false);
  expect(allow({ isTopFrame: true, url: 'http://127.0.0.1:5002/proxy.html' })).toBe(true);
  expect(allow({ isTopFrame: true, url: 'http://127.0.0.1:5001/resource.html' })).toBe(false);
  expect(allow({ isTopFrame: false, url: 'javascript:alert(1)' })).toBe(false);
  // Android supplies no frame identity, including for about:srcdoc and nested frames.
  expect(allow({ url: 'about:srcdoc' })).toBe(true);
  expect(allow({ url: 'http://127.0.0.1:5001/resource.html' })).toBe(true);
  expect(allow({ url: 'https://frame.example.org/embed' })).toBe(true);
  expect(allow({ url: 'https://other.example.org/embed' })).toBe(false);
  expect(allow({ url: 'https://frame.example.org.evil.test/embed' })).toBe(false);
  expect(allow({ url: 'file:///private' })).toBe(false);
  expect(allow({ url: 'javascript:alert(1)' })).toBe(false);
  expect(
    allow({
      isTopFrame: true,
      url: 'https://view.cindy-app.invalid/elsewhere',
    }),
  ).toBe(false);
  state.props.onMessage({
    nativeEvent: {
      data: JSON.stringify({
        key: state.prepare.mock.calls[0][1],
        message: {
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-proxy-ready',
        },
      }),
    },
  });
  const script = state.inject.mock.calls[0][0];
  expect(script).not.toContain('<');
  const dispatchEvent = vi.fn();
  new Script(script).runInNewContext({
    window: { dispatchEvent },
    MessageEvent: class {
      data: unknown;
      constructor(_type: string, init: { data: unknown }) {
        this.data = init.data;
      }
    },
  });
  expect(dispatchEvent.mock.calls[0][0].data.params.html).toContain(doc.html);

  // Exercise the actual native proxy: its sandbox must prevent every App and
  // descendant from navigating the trusted top document, even with user activation.
  const shell = document.implementation.createHTMLDocument();
  const listeners = new Map<string, (event: unknown) => void>();
  const nativePost = vi.fn();
  const proxy = {
    location: { href: state.props.source.uri },
    ReactNativeWebView: { postMessage: nativePost },
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
  };
  const proxyDocument = new DOMParser().parseFromString(mcpAppSandboxDocument(state.prepare.mock.calls[0][1],
    'http://127.0.0.1:5001/resource.html'), 'text/html');
  const proxyScript = proxyDocument.querySelector('script')!.textContent!;
  new Script(proxyScript).runInNewContext({ document: shell, window: proxy, URL });
  listeners.get('message')!({
    source: proxy,
    data: dispatchEvent.mock.calls[0][0].data,
  });
  const appFrame = shell.querySelector('iframe')!;
  expect(appFrame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  expect(appFrame.srcdoc).toBe('');
  expect(appFrame.src).toBe('http://127.0.0.1:5001/resource.html');
  // The same WindowProxy can now name a frame-domain replacement document.
  // Its real event.origin, rather than Android's missing isTopFrame, is decisive.
  nativePost.mockClear();
  const message = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'write' } };
  listeners.get('message')!({ source: appFrame.contentWindow, origin: 'https://frame.example.org', data: message });
  expect(nativePost).not.toHaveBeenCalled();
  listeners.get('message')!({ source: {}, origin: 'http://127.0.0.1:5001', data: message });
  expect(nativePost).not.toHaveBeenCalled();
  listeners.get('message')!({ source: appFrame.contentWindow, origin: 'http://127.0.0.1:5001', data: message });
  expect(JSON.parse(nativePost.mock.calls[0][0]).message).toEqual(message);
});

it('rejects a Desktop-only descriptor without starting a native document or leaving a View open', async () => {
  state.invoke.mockResolvedValueOnce({ viewId: 'view', transport: 'sandbox', prefersBorder: true });
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />));
  expect(state.prepare).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBeNull();
  expect(container.textContent).toContain('mcpApps.loadFailed');
  expect(state.invoke).toHaveBeenCalledWith('device', 'maker:mcp-apps:v1', [
    'task', { op: 'teardown', viewId: 'view', alreadyNotified: false },
  ]);
});

it('closes late native servers without mounting them after the card has left the screen', async () => {
  let prepared!: (value: typeof nativeDocument) => void;
  const close = vi.fn(async () => {});
  state.prepare.mockImplementation(() => new Promise((resolve) => { prepared = resolve; }));
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />));
  expect(state.prepare).toHaveBeenCalledOnce();
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" active={false} />));
  await act(async () => prepared({ ...nativeDocument, close }));
  expect(close).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBeNull();
});

it.each(['inactive', 'parent-unmount'])('keeps the same live WebView until teardown responds after %s', async (reason) => {
  const close = vi.fn(async () => {});
  state.prepare.mockResolvedValue({ ...nativeDocument, close });
  const card = (active = true) => <McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" active={active} />;
  await act(async () => render(card()));
  const original = container.querySelector('[data-testid="mcp-webview"]');
  const props = state.props;
  const key = state.prepare.mock.calls[0][1];
  await act(async () => props.onMessage({ nativeEvent: { data: JSON.stringify({ key,
    message: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' } }) } }));
  state.inject.mockClear();
  await act(async () => render(reason === 'inactive' ? card(false) : null));
  expect(container.querySelector('[data-slot]')).toBeNull();
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBe(original);
  expect(state.mounts).toBe(1);
  expect(close).not.toHaveBeenCalled();
  const dispatchEvent = vi.fn();
  new Script(state.inject.mock.calls[0][0]).runInNewContext({
    window: { dispatchEvent },
    MessageEvent: class { data: unknown; constructor(_type: string, init: any) { this.data = init.data; } },
  });
  const teardown = dispatchEvent.mock.calls[0][0].data;
  expect(teardown.method).toBe('ui/resource-teardown');
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBe(original);
  await act(async () => props.onMessage({ nativeEvent: { data: JSON.stringify({ key,
    message: { jsonrpc: '2.0', id: teardown.id, result: {} } }) } }));
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect(state.invoke.mock.calls.map(([, , [, input]]) => input).filter((i) => i.op === 'teardown'))
    .toEqual([expect.objectContaining({ alreadyNotified: true })]);
});

it('disposes at one second even when App teardown and remote teardown never return', async () => {
  const close = vi.fn(async () => {});
  state.prepare.mockResolvedValue({ ...nativeDocument, close });
  state.invoke.mockImplementation(async (_device, _channel, [, input]) => {
    if (input.op === 'open') return { ...doc };
    if (input.op === 'poll' || input.op === 'teardown') return new Promise(() => {});
    return {};
  });
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />));
  await act(async () => state.props.onMessage({ nativeEvent: { data: JSON.stringify({
    key: state.prepare.mock.calls[0][1], message: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' },
  }) } }));
  await act(async () => render(null));
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(container.querySelector('[data-testid="mcp-webview"]')).not.toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it('reopens a fresh View after background shutdown without replaying App tools', async () => {
  const close = vi.fn(async () => {});
  state.prepare.mockResolvedValue({ ...nativeDocument, close });
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />));
  const background = (value: string) => { for (const listener of state.appStateListeners) listener(value); };
  const original = container.querySelector('[data-host]')?.getAttribute('data-host');
  await act(async () => background('background'));
  expect(container.querySelector('[data-slot]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  await act(async () => background('active'));
  expect(container.querySelector('[data-host]')?.getAttribute('data-host')).not.toBe(original);
  const ops = state.invoke.mock.calls.map(([, , [, input]]) => input.op);
  expect(ops.filter((op) => op === 'open')).toHaveLength(2);
  expect(ops).not.toContain('message');
});

it.each(['light', 'dark'])('keeps saved text and requests a phone update on old binaries in %s mode', async (mode) => {
  state.mode = mode;
  state.surfaceAvailable = false;
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" fallbackText="Saved text" />));
  expect(container.textContent).toContain('mcpApps.mobileUpdateRequired');
  expect(container.textContent).toContain('Saved text');
  expect(state.invoke).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="mcp-webview"]')).toBeNull();
});

it('hosts four independently bound visible cards without sharing bridge keys', async () => {
  await act(async () => render(<>{Array.from({ length: 4 }, (_, index) =>
    <McpAppCard key={index} deviceId="device" sessionId="task" clientId={String(index)} title="App" />)}</>));
  expect(container.querySelectorAll('[data-host]')).toHaveLength(4);
  expect(container.querySelectorAll('[data-slot]')).toHaveLength(4);
  expect(state.prepare).toHaveBeenCalledTimes(4);
  expect(new Set(state.prepare.mock.calls.map(([, key]) => key)).size).toBe(4);
});

it('releases offscreen Views, stops polling and reopens only the newly visible card', async () => {
  const polls = new Map<string, (events: unknown[]) => void>();
  state.invoke.mockImplementation(async (_device, _channel, [, input]) => {
    if (input.op === 'open') return { ...doc, viewId: input.clientId };
    if (input.op === 'poll') return new Promise((resolve) => polls.set(input.viewId, resolve));
    return {};
  });
  const renderCards = (visible: number) =>
    render(
      <>
        {Array.from({ length: 6 }, (_, index) => (
          <McpAppCard
            key={index}
            deviceId="device"
            sessionId="task"
            clientId={`card-${index}`}
            title="App"
            active={index === visible}
          />
        ))}
      </>,
    );
  const inputs = (op: string) =>
    state.invoke.mock.calls.map(([, , [, input]]) => input).filter((input) => input.op === op);
  await act(async () => renderCards(-1));
  expect(state.invoke).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(0);

  await act(async () => renderCards(0));
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0']);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(1);
  await act(async () => renderCards(5));
  expect(inputs('teardown')).toEqual([expect.objectContaining({ viewId: 'card-0' })]);
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0', 'card-5']);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(1);

  // A poll from the old View cannot inject into the replacement or schedule another poll.
  state.inject.mockClear();
  await act(async () =>
    polls.get('card-0')!([{ seq: 1, message: { jsonrpc: '2.0', method: 'old' } }]),
  );
  expect(state.inject).not.toHaveBeenCalled();
  expect(inputs('poll').filter((input) => input.viewId === 'card-0')).toHaveLength(1);
  await act(async () => renderCards(0));
  expect(inputs('teardown').map((input) => input.viewId)).toEqual(['card-0', 'card-5']);
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0', 'card-5', 'card-0']);
});

it('cancels an offscreen pending open and disposes its late View without mounting it', async () => {
  let finishOpen!: (document: typeof doc) => void;
  state.invoke.mockImplementation(async (_device, _channel, [, input]) =>
    input.op === 'open'
      ? new Promise((resolve) => {
          finishOpen = resolve;
        })
      : {},
  );
  const renderCard = (active: boolean) =>
    render(
      <McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" active={active} />,
    );
  await act(async () => renderCard(true));
  const opening = state.invoke.mock.calls[0][2][1];
  await act(async () => renderCard(false));
  expect(state.invoke).toHaveBeenCalledWith('device', 'maker:mcp-apps:v1', [
    'task',
    { op: 'cancel-open', openId: opening.openId },
  ]);
  await act(async () => finishOpen({ ...doc }));
  expect(state.invoke).toHaveBeenCalledWith('device', 'maker:mcp-apps:v1', [
    'task',
    { op: 'teardown', viewId: 'view' },
  ]);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(0);
  expect(state.invoke.mock.calls.map(([, , [, input]]) => input.op)).toEqual([
    'open',
    'cancel-open',
    'teardown',
  ]);
});

it.each(['light', 'dark'])('renders read-only guest history without invoking the Host in %s mode', async (mode) => {
  state.mode = mode;
  const deviceId = sharedTaskHostPeer('shared-task', 'host-device');
  await act(async () => render(<McpAppCard deviceId={deviceId} sessionId="task" clientId="card"
    title="Saved form" fallbackText="Saved result <script>window.attack=true</script>" />));
  expect(container.textContent).toContain('Saved form');
  expect(container.textContent).toContain('Saved result <script>window.attack=true</script>');
  expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
  expect(container.textContent).not.toContain('mcpApps.loadFailed');
  expect(container.querySelector('[data-testid="mcp-webview"], button, script')).toBeNull();
  expect(state.invoke).not.toHaveBeenCalled();
  expect(state.inject).not.toHaveBeenCalled();
  await act(async () => render(<McpAppCard deviceId={deviceId} sessionId="task" clientId="pending" title="Pending form" />));
  expect(container.textContent).toContain('Pending form');
  expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
});

it.each(['light', 'dark'])('keeps saved text readable after App failures and retry in %s mode', async (mode) => {
  state.mode = mode;
  state.invoke.mockRejectedValueOnce(new Error('MCP_APP_SERVER_CHANGED'));
  const saved = 'Saved result\n<script>window.attack=true</script>';
  await act(async () => render(
    <McpAppCard deviceId="device" sessionId="task" clientId="card" title="Saved form" fallbackText={saved} />,
  ));
  expect(container.textContent).toContain(saved);
  expect(container.textContent).toContain('mcpApps.loadFailed');
  expect(container.querySelector('[data-testid="mcp-webview"], script')).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).not.toContain(saved);
  expect(container.querySelector('[data-testid="mcp-webview"]')).not.toBeNull();
  await act(async () => state.props.onError());
  expect(container.textContent).toContain(saved);
  expect(container.querySelector('[data-testid="mcp-webview"], script')).toBeNull();
});

/* 依据：本期不转发执行电脑文件（含对话交接副本 handoff:）。缺口：已有 App 测试没有本插件文件引用。
 * 最小输入：Host 向 View 发送含一个 local resource_link 的工具结果；tier: unit，真实卡片/controller。 */
it.each(['cindy-media://blobs/file.png', 'library:reports/one.pdf', 'handoff:00000000-0000-4000-8000-000000000000', 'https://example.org/image.png'])(
  'only downgrades execution-computer file references (%s)', async (uri) => {
    let delivered = false;
    state.invoke.mockImplementation(async (_device, _channel, [, input]) => {
      if (input.op === 'open') return { ...doc };
      if (input.op === 'poll') {
        if (delivered) return new Promise(() => {});
        delivered = true;
        return [{ seq: 1, message: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
          content: [{ type: 'resource_link', uri, name: 'file' }],
        } } }];
      }
      return {};
    });
    await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" fallbackText="Saved text" />));
    await act(async () => state.props.onMessage({ nativeEvent: { data: JSON.stringify({ key: state.prepare.mock.calls[0][1],
      message: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' } }) } }));
    const local = !uri.startsWith('https:');
    expect(container.textContent?.includes('mcpApps.filesOnExecutionComputer')).toBe(local);
    expect(container.textContent?.includes('Saved text')).toBe(local);
    expect(container.textContent).not.toContain('mcpApps.loadFailed');
    expect(container.querySelector('button')).toBeNull();
    expect(state.inject.mock.calls.some(([script]) => script.includes(uri))).toBe(!local);
    expect(container.querySelector('[data-slot]') === null).toBe(local);
  },
);
it.each(['MCP_APP_FILES_LOCAL_ONLY', '[PRECONDITION_FAILED] MCP_APP_FILES_LOCAL_ONLY'])('renders a local-files Host refusal without a retry error (%s)', async message => {
  state.invoke.mockRejectedValueOnce(new Error(message));
  await act(async () => render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" fallbackText="Report" />));
  expect(container.textContent).toContain('mcpApps.filesOnExecutionComputer');
  expect(container.textContent).toContain('Report');
  expect(container.querySelector('button, [data-testid="mcp-webview"]')).toBeNull();
});
