// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../shared/ghost';
import { NativePluginUiState } from '../../../main/mcp-apps/nativeState';
import type { PluginUiStateChange } from '../../../shared/pluginUi';
const installed = vi.hoisted(() => ({ ghosts: [] as InstalledGhost[] }));
const translation = vi.hoisted(() => ({ read: vi.fn(() => ({ t: (key: string) => key })) }));
const page = vi.hoisted(() => ({ mounted: vi.fn(), released: vi.fn() }));
vi.mock('../useInstalledGhosts', () => ({ useInstalledGhosts: (enabled = true) => enabled ? installed.ghosts : [],
  readInstalledGhostsSnapshot: () => installed.ghosts }));
vi.mock('react-i18next', () => ({ useTranslation: translation.read }));
// Presenter lifetime is covered separately at McpAppCard; replace only that boundary here.
vi.mock('../PluginUiView', async () => {
  const { useEffect } = await import('react');
  return { PluginUiView: () => { useEffect(() => { page.mounted(); return page.released; }, []); return <div>Local page</div>; } };
});
import { memo } from 'react';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES, PluginUiBody, PluginUiProvider, PluginUiSlot, PluginUiSlotControls, PluginUiSidebarSections, readPluginUiEntries, renderPluginUiBody, usePluginUiMessageCandidates, type PluginUiMessageCandidates } from '../PluginUiContributions';

// 生产入口：真实 Provider/正文/控件；只替换已装投影与 IPC，Main 订阅适配器不替换。
// 规则与旧回归：无候选历史行不发请求、不构造数据；原测试只覆盖 App frame。
// 最小输入：100/1000 条原文或两个可见控件共享一个源，观察原文、IPC 和源释放。tier: unit。
let receive: ((update: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
let host: NativePluginUiState;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  translation.read.mockClear();
  page.mounted.mockClear(); page.released.mockClear();
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

it('opens a page beside its trigger only on demand and releases it on close', async () => {
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
        host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }],
          contributions: [{ id: 'open', title: 'Open here', position: 'composer.toolbar', view: 'view', presentation: 'popover' }] },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  render(<PluginUiProvider><PluginUiSlot position="composer.toolbar" sessionId="task-a" /></PluginUiProvider>);
  expect(page.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  expect(await screen.findByText('Local page')).toBeTruthy();
  expect(page.mounted).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  await waitFor(() => expect(screen.queryByText('Local page')).toBeNull());
  expect(page.released).toHaveBeenCalledTimes(1);
});

// Unit, sidebar lifecycle: no page before expansion; close/revoke releases the View.
// Existing popover tests cannot cover a persistent sidebar section. Empty directory
// must keep the original aside with no native IPC. Frame protocol is tested separately.
it('loads sidebar sections only on expansion and removes them after revocation', async () => {
  const Sections = () => {
    const entries = readPluginUiEntries('sidebar.section');
    return <aside><span>Original sidebar</span>{entries.length > 0 && <PluginUiSidebarSections entries={entries} sessionId={null} />}</aside>;
  };
  const view = render(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(screen.getByText('Original sidebar')).toBeTruthy(); expect(invoke).not.toHaveBeenCalled();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: {
        ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} }, host: {
          views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'global' }],
          contributions: [{ id: 'summary', title: 'Summary', position: 'sidebar.section', view: 'view' }],
        },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(page.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Summary · Planner' }));
  expect(await screen.findByText('Local page')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Summary · Planner' }));
  expect(screen.queryByText('Local page')).toBeNull(); expect(page.released).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Summary · Planner' }));
  expect(await screen.findByText('Local page')).toBeTruthy();
  installed.ghosts = [{ ...ghost, approvedHostUi: [] }];
  view.rerender(<PluginUiProvider><Sections /></PluginUiProvider>);
  expect(screen.queryByRole('button', { name: 'Summary · Planner' })).toBeNull();
  expect(page.released).toHaveBeenCalledTimes(2); expect(screen.getByText('Original sidebar')).toBeTruthy();
});

// Unit: titlebar actions use the original native action IPC and disappear on revoke.
// Existing toolbar buttons do not cover the newly approved placement. No candidate
// must add a control consumer or invoke IPC; original title content stays in place.
it('runs an approved titlebar action and restores the original chrome after revocation', async () => {
  const Chrome = () => {
    const entries = readPluginUiEntries('window.titlebar');
    return <header><span>Original chrome</span>{entries.length > 0 && <PluginUiSlotControls entries={entries} appearance="titlebar" />}</header>;
  };
  const view = render(<PluginUiProvider><Chrome /></PluginUiProvider>);
  expect(invoke).not.toHaveBeenCalled(); expect(translation.read).not.toHaveBeenCalled();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [{ name: 'refresh', description: 'Refresh' }], mcpApps: {
        ui: { resources: [], tools: { refresh: { visibility: ['app'] } } }, host: {
          contributions: [{ id: 'refresh', title: 'Refresh', position: 'window.titlebar', tool: 'refresh' }],
        },
      } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider><Chrome /></PluginUiProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh · Planner' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith(null,
    { op: 'plugin-action', instanceId: 'planner', id: 'refresh', value: undefined }));
  installed.ghosts = [{ ...ghost, approvedHostUi: [] }];
  view.rerender(<PluginUiProvider><Chrome /></PluginUiProvider>);
  expect(screen.queryByRole('button', { name: 'Refresh · Planner' })).toBeNull();
  expect(screen.getByText('Original chrome')).toBeTruthy();
});

it('mounts the window host only for enabled and approved host declarations', () => {
  const view = render(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
  const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
    approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'planner', name: 'Planner',
      kind: 'chip', entry: 'main.js', version: '1', tools: [], mcpApps: { host: { capabilities: ['draft'] } } } };
  ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest); installed.ghosts = [ghost];
  view.rerender(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.getByText('Window host')).toBeTruthy();
  view.rerender(<PluginUiProvider enabled={false} host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
  installed.ghosts = [{ ...ghost, enabled: false }];
  view.rerender(<PluginUiProvider host={<span>Window host</span>}>Chat</PluginUiProvider>);
  expect(screen.queryByText('Window host')).toBeNull();
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

it('keeps 500 message rows and 1000 tool bodies on their original elements with one stable candidate projection', () => {
  const rowRender = vi.fn();
  const Row = memo(({ candidates }: { candidates: PluginUiMessageCandidates }) => {
    rowRender();
    const message = <span>Original message</span>;
    const tool = <span>Original tool</span>;
    const body = renderPluginUiBody(candidates.messageBody ? { position: 'message.body' } : undefined, message);
    const toolBody = renderPluginUiBody(candidates.toolBody ? { position: 'tool.body' } : undefined, tool);
    expect(body).toBe(message); expect(toolBody).toBe(tool);
    return <article>{body}{toolBody}{toolBody}{candidates.messageActions && <PluginUiSlot position="message.actions" />}
      {candidates.turnFooter && <PluginUiSlot position="turn.footer" />}</article>;
  });
  let projection: PluginUiMessageCandidates | undefined;
  const List = () => {
    const candidates = usePluginUiMessageCandidates();
    projection = candidates;
    return <>{Array.from({ length: 500 }, (_, index) => <Row key={index} candidates={candidates} />)}</>;
  };
  const view = render(<PluginUiProvider><List /></PluginUiProvider>);
  expect(projection).toBe(EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES);
  expect(rowRender).toHaveBeenCalledTimes(500);
  expect(screen.getAllByText('Original tool')).toHaveLength(1000);
  installed.ghosts = [{ enabled: false } as InstalledGhost];
  view.rerender(<PluginUiProvider><List /></PluginUiProvider>);
  expect(projection).toBe(EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES);
  expect(rowRender).toHaveBeenCalledTimes(500);
  expect(invoke).not.toHaveBeenCalled(); expect(translation.read).not.toHaveBeenCalled();
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
