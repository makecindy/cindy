// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../shared/ghost';
import { NativePluginUiState } from '../../../main/mcp-apps/nativeState';
import type { PluginUiStateChange } from '../../../shared/pluginUi';
const installed = vi.hoisted(() => ({ ghosts: [] as InstalledGhost[] }));
const translation = vi.hoisted(() => ({ read: vi.fn(() => ({ t: (key: string) => key })) }));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: () => installed.ghosts }));
vi.mock('react-i18next', () => ({ useTranslation: translation.read }));
import { PluginUiBody, PluginUiProvider, PluginUiSlot } from '../PluginUiContributions';

// 生产入口：真实 Provider/正文/控件；只替换已装投影与 IPC，Main 订阅适配器不替换。
// 规则与旧回归：无候选历史行不发请求、不构造数据；原测试只覆盖 App frame。
// 最小输入：100/1000 条原文或两个可见控件共享一个源，观察原文、IPC 和源释放。tier: unit。
let receive: ((update: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
let host: NativePluginUiState;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  translation.read.mockClear();
  installed.ghosts = [];
  const authority = {};
  host = new NativePluginUiState({ owner: () => 'owner', authority: () => authority, demand: () => {},
    send: (_caller, epoch, updates) => receive?.({ epoch, updates }) });
  invoke = vi.fn(async (_session: unknown, input: { op: string; epoch: string; entries: [] }) =>
    input.op === 'native-interest' ? { updates: host.subscribe('renderer:1', input.epoch, input.entries) } : {});
  window.electronAPI = { maker: { mcpApps: invoke, onPluginUiState: (listener: NonNullable<typeof receive>) => {
    receive = listener; return () => { receive = undefined; };
  } } } as unknown as typeof window.electronAPI;
});
afterEach(async () => { cleanup(); await Promise.resolve(); await Promise.resolve(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([100, 1000])('keeps %i ordinary history rows free of additional payload construction and IPC', (count) => {
  const context = vi.fn(() => ({ message: 'Should not be built' }));
  render(<PluginUiProvider>{Array.from({ length: count }, (_, index) =>
    <PluginUiBody key={index} position="message.body" sessionId="task-a" context={context}><span>Original</span></PluginUiBody>)}
  </PluginUiProvider>);
  expect(screen.getAllByText('Original')).toHaveLength(count);
  expect(context).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  expect(translation.read).not.toHaveBeenCalled();
});

it('does not subscribe history when the installed plugin only matches another kind of tool', () => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view' }],
          contributions: [{ id: 'body', title: 'Body', position: 'tool.body', view: 'view', match: { tools: ['other'] } }] },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  const context = vi.fn(() => ({}));
  render(<PluginUiProvider><PluginUiBody position="tool.body" sessionId="task-a" tool="actual" context={context}>Original</PluginUiBody></PluginUiProvider>);
  expect(screen.getByText('Original')).toBeTruthy(); expect(invoke).not.toHaveBeenCalled(); expect(context).not.toHaveBeenCalled();
});

it('shares a visible control source, applies its update, and releases it when the controls unmount', async () => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { contributions: [{ id: 'progress', title: 'Ready', position: 'statusbar', kind: 'status' }] },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  const view = render(<PluginUiProvider><PluginUiSlot position="statusbar" sessionId="task-a" /><PluginUiSlot position="statusbar" sessionId="task-a" /></PluginUiProvider>);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(host.consumers('planner')).toHaveLength(1);
  await act(async () => { host.publish('planner', 'progress', undefined, () => ({ title: 'Working' })); });
  expect(screen.getAllByText('Working')).toHaveLength(2);
  view.unmount(); await act(async () => {});
  expect(host.consumers('planner')).toBeUndefined();
});

it.each([100, 1000])('subscribes only visible native controls among %i mounted history rows', async count => {
  let report!: IntersectionObserverCallback;
  const elements = new Set<Element>();
  const disconnect = vi.fn();
  const observe = vi.fn((element: Element) => { elements.add(element); });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { report = callback; }
    observe = observe;
    unobserve(element: Element) { elements.delete(element); }
    disconnect = disconnect;
  });
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { contributions: [{ id: 'progress', title: 'Ready', position: 'turn.footer', kind: 'status' }] },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  const view = render(<PluginUiProvider>{Array.from({ length: count }, (_, index) =>
    <div key={index} data-message-client-id={`message-${index}`}>
      <PluginUiSlot position="turn.footer" sessionId="task-a" clientId={`message-${index}`} />
    </div>)}
  </PluginUiProvider>);
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(count);
  const visible = [...elements].slice(0, 3);
  const visibility = (intersecting: boolean) => report(visible.map(target => ({ target, isIntersecting: intersecting })) as IntersectionObserverEntry[], {} as IntersectionObserver);
  await act(async () => { visibility(true); });
  expect(host.consumers('planner')).toHaveLength(3);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].entries).toHaveLength(3);
  const documentVisibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(host.consumers('planner')).toBeUndefined();
  documentVisibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(host.consumers('planner')).toHaveLength(3);
  await act(async () => { host.publish('planner', 'progress', { sessionId: 'task-a', clientId: 'message-0' }, () => ({ title: 'Changed' })); });
  expect(screen.getAllByText('Changed')).toHaveLength(1);
  await act(async () => { visibility(false); });
  expect(host.consumers('planner')).toBeUndefined();
  const build = vi.fn(() => ({ title: 'Offscreen' }));
  host.publish('planner', 'progress', undefined, build);
  expect(build).not.toHaveBeenCalled();
  view.unmount();
  expect(elements.size).toBe(0);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
