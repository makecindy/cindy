// @vitest-environment jsdom
/** Unit timing regression for useSidebarPresentation: opening must not compress chat
 * between the native IPC reply and viewport resize. LayoutRoot tests alone do not control
 * these independent deliveries; delay resize after resolving one open request.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  isTaskSessionRoute,
  isTasklessPageRoute,
  passiveRevealOnBackgroundOpen,
  rewritesRevealSource,
  useSidebarPresentation,
} from '../sidebarPresentation';

const root = { current: { getBoundingClientRect: () => ({ width: 800 }) } } as never;
const width = () => 800;
let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => { frames.push(fn); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true, configurable: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function frame() { act(() => { const pending = frames.splice(0); pending.forEach((fn) => fn(0)); }); }

it('holds the old chat layout until both the IPC reply and renderer resize arrive', async () => {
  let resolve!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: vi.fn(() => new Promise<number>((done) => { resolve = done; })) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  expect(result.current).toEqual({ collapsed: true, instant: true, frozenWidth: 800 });
  await act(async () => { resolve(800); });
  act(() => { window.dispatchEvent(new Event('resize')); });
  expect(result.current.collapsed).toBe(true);
  expect(result.current.frozenWidth).toBe(800);
  window.innerWidth = 1800;
  act(() => { window.dispatchEvent(new Event('resize')); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1600 });
});

// #11560: when the viewport arrives first, neither direction needs a frame after the reply.
it('applies both open and close replies immediately at the target viewport', async () => {
  let reply!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: () => new Promise<number>((done) => { reply = done; }) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  window.innerWidth = 1800;
  await act(async () => { reply(800); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1600 });
  rerender({ collapsed: true });
  window.innerWidth = 1000;
  await act(async () => { reply(-800); });
  expect(result.current).toEqual({ collapsed: true, instant: true });
});

it('keeps the ordinary animation when native expansion has no room', async () => {
  window.electronAPI = { windowSidebarExpansion: vi.fn(async () => 0) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  await act(async () => { rerender({ collapsed: false }); });
  expect(result.current).toEqual({ collapsed: false, instant: false, expandedWidth: 800 });
});

it('ignores a late open reply after the user has already closed', async () => {
  const replies: ((delta: number) => void)[] = [];
  window.electronAPI = { windowSidebarExpansion: vi.fn(() => new Promise<number>((done) => { replies.push(done); })) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  rerender({ collapsed: true });
  await act(async () => { replies[1](0); replies[0](800); });
  frame();
  expect(result.current).toEqual({ collapsed: true, instant: false });
});

// Codex P2: the close supersedes the open, even when the stale reply needs no polling.
it('does not reopen when a superseded open reply lands at the old target', async () => {
  const replies: ((delta: number) => void)[] = [];
  window.electronAPI = { windowSidebarExpansion: vi.fn(() => new Promise<number>((done) => { replies.push(done); })) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  // Close before the open reply: the viewport never grew, so the stale reply's target is
  // already the current width and its `finish` commits on the spot.
  rerender({ collapsed: true });
  await act(async () => { replies[1](0); replies[0](0); });
  frame();
  expect(result.current).toEqual({ collapsed: true, instant: false });
});

it('releases the frozen layout if the native request fails', async () => {
  window.electronAPI = { windowSidebarExpansion: vi.fn(async () => { throw new Error('unavailable'); }) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  await act(async () => { rerender({ collapsed: false }); });
  expect(result.current).toEqual({ collapsed: false, instant: false });
});

// Unit regression: startup must expand the saved standalone bounds instead of
// subtracting a sidebar from them; closing must not use the divider's new width.
it('expands a restored-open sidebar and closes without a renderer-derived shrink', async () => {
  const resize = vi.fn(async (requested: number) => requested > 0 ? 301 : -301);
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, () => 301),
    { initialProps: { collapsed: false } });
  await act(async () => undefined);
  expect(resize).toHaveBeenCalledExactlyOnceWith(301);
  expect(result.current.collapsed).toBe(true);
  window.innerWidth = 1301;
  frame();
  expect(result.current.collapsed).toBe(false);
  await act(async () => { rerender({ collapsed: true }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  window.innerWidth = 1000;
  frame();
  expect(result.current.collapsed).toBe(true);
});

// Bug: opening a task from the system island restores that task's remembered sidebar
// state; the session switch then restored the standalone window and narrowed it.
it('keeps the window width when a session switch restores the sidebar state', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : -401));
  const settle = vi.fn(async () => undefined);
  window.electronAPI = { windowSidebarExpansion: resize, windowSidebarSettle: settle } as never;
  const { result, rerender } = renderHook(
    ({ collapsed, userToggle }) => useSidebarPresentation(root, collapsed, true, () => 400, userToggle),
    { initialProps: { collapsed: true, userToggle: true } },
  );
  await act(async () => { rerender({ collapsed: false, userToggle: true }); });
  window.innerWidth = 1401;
  frame();
  expect(resize).toHaveBeenCalledExactlyOnceWith(400);
  expect(settle).not.toHaveBeenCalled();
  resize.mockClear();
  await act(async () => { rerender({ collapsed: true, userToggle: false }); });
  expect(resize).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledOnce();
  expect(result.current).toEqual({ collapsed: true, instant: true });
  await act(async () => { rerender({ collapsed: false, userToggle: false }); });
  expect(resize).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledOnce();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 800 });
});

// Bug: leaving the chat route retracts the expansion; returning must expand again
// instead of adopting the shrunken window (repeated navigation narrowed it 1800 → 1399 → 998).
// Codex P2: a pane that is not on screen is not "already open" — the program open that
// brings it back owns the source, so it must not widen the window later.
it('treats an open on a pane that is not shown as a source rewrite', () => {
  expect(rewritesRevealSource({ visibility: 'open', userInitiated: false, collapsed: false })).toBe(false);
  expect(rewritesRevealSource({ visibility: 'open', userInitiated: false, collapsed: true })).toBe(true);
});

it('re-expands when returning to a sidebar route after it was retracted', async () => {
  const resize = vi.fn(async (requested: number, _shrink?: number, adopt?: boolean) => (requested > 0 || adopt ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(({ ready }) => useSidebarPresentation(root, false, ready, () => 400),
    { initialProps: { ready: true } });
  await act(async () => undefined);
  resize.mockClear();
  await act(async () => { rerender({ ready: false }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  await act(async () => { rerender({ ready: true }); });
  expect(resize).toHaveBeenLastCalledWith(400);
  expect(resize.mock.calls.some((call) => call[2] === true)).toBe(false);
});

// Bug: 程序展开（agent / 插件动作，userToggle=false）本来就不拉宽窗口；进设置页再回来
// 曾因基线丢失被当成启动恢复，一次往返就把自动展示变成手点开标。
it('keeps a programmatic reveal unexpanded across a route gap', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { result, rerender } = renderHook(
    ({ ready, collapsed }) => useSidebarPresentation(root, collapsed, ready, () => 400, false),
    { initialProps: { ready: true, collapsed: true } },
  );
  await act(async () => { rerender({ ready: true, collapsed: false }); });
  expect(resize).not.toHaveBeenCalled();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 800 });
  await act(async () => { rerender({ ready: false, collapsed: false }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  resize.mockClear();
  await act(async () => { rerender({ ready: true, collapsed: false }); });
  expect(resize).not.toHaveBeenCalled();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 800 });
});

// Bug: 就绪空档里换了任务（例如在设置页从系统岛跳到另一个任务），落到的那个任务的
// 记忆状态不是用户这次要开栏，不能拉宽窗口；用户直接点名展开的落回仍要展开。
// Codex P1: a metadata-only rerender (same collapsed state, new sessionKey) must not
// release a native open/close that is still settling.
it('keeps a settling request when only the session key changes', async () => {
  let reply!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: vi.fn(() => new Promise<number>((done) => { reply = done; })) } as never;
  const { result, rerender } = renderHook(
    ({ sessionKey }) => useSidebarPresentation(root, false, true, width, true, sessionKey),
    { initialProps: { sessionKey: 'task-a' } },
  );
  expect(result.current.frozenWidth).toBe(800);
  // The reply has not arrived yet; a session declaration alone must not drop the freeze.
  act(() => { rerender({ sessionKey: 'task-b' }); });
  expect(result.current.collapsed).toBe(true);
  expect(result.current.frozenWidth).toBe(800);
  window.innerWidth = 1800;
  await act(async () => { reply(800); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1600 });
});

// 启动落在哪个路由由 URL 判断，不看子视图声明的右栏在场（它要等自己的 effect）。
it('reads the startup route from the URL, not from the sidebar declaration', () => {
  // 任务会话才有可恢复的右栏记忆；/cc-agent 下的静态段与其它路由都不算。
  expect(isTaskSessionRoute('/cc-agent/session-a')).toBe(true);
  expect(isTaskSessionRoute('/cc-agent/7f6d1a2b-3c4d')).toBe(true);
  for (const pathname of ['/cc-agent', '/cc-agent/new', '/cc-agent/scheduled', '/cc-agent/files/session-a',
    '/cc-agent/orca/session-a', '/settings', '/bots/roster']) {
    expect(isTaskSessionRoute(pathname)).toBe(false);
  }
  // Codex P1: 冷启动的 URL 不是恢复后的任务 URL——`/` 交给 MainEntryRedirect，
  // `/cc-agent` 再交给 CCAgentIndexRedirect 恢复上次任务。这两步都不是「用户落在
  // 无侧栏页面上」，不能记成无侧栏启动，否则每次普通重启都会把存档开着的侧栏挤窄。
  expect(isTasklessPageRoute('/')).toBe(false);
  expect(isTasklessPageRoute('/cc-agent')).toBe(false);
  // 副窗也是从 /cc-agent/boot 换进真正的任务；`/cc-agent/orca/:id` 与伙伴历史的
  // `/bots/.../history/:id` 同样是跳向任务的网关，都不算落地。
  expect(isTasklessPageRoute('/cc-agent/boot')).toBe(false);
  expect(isTasklessPageRoute('/cc-agent/orca/session-a')).toBe(false);
  expect(isTasklessPageRoute('/bots/bot-a/history/session-a')).toBe(false);
  expect(isTasklessPageRoute('/bots/remote/dev-a/bot-a/history/session-a')).toBe(false);
  expect(isTasklessPageRoute('/cc-agent/session-a')).toBe(false);
  for (const pathname of ['/settings', '/bots/roster', '/plugins', '/cc-agent/new']) {
    expect(isTasklessPageRoute(pathname)).toBe(true);
  }
});

// Codex P1: 冷启动落在 /settings、/bots 这类无侧栏页面，之后通知把窗口带到「存档里右栏
// 开着」的任务上。这条不是启动恢复，窗口保持原宽。
it('does not expand on the first task landing after a taskless start', async () => {
  const resize = vi.fn(async () => 800);
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(
    ({ ready, sessionKey, tasklessRoute }) =>
      useSidebarPresentation(root, false, ready, width, false, sessionKey, false, true, tasklessRoute),
    { initialProps: { ready: false, sessionKey: '', tasklessRoute: true } },
  );
  await act(async () => { rerender({ ready: true, sessionKey: 'task-a', tasklessRoute: false }); });
  expect(resize).not.toHaveBeenCalled();
});

// 同一族判据的另一半：任务路由冷启动时首帧 sessionKey 还没填、ready 仍为 false，
// 但路由来源是任务，所以那是启动恢复，照常按存档展开——不能被当成「落地」。
it('expands a task restored during startup even before the session key arrives', async () => {
  const resize = vi.fn(async () => 800);
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(
    ({ ready, sessionKey }) =>
      useSidebarPresentation(root, false, ready, width, false, sessionKey, false, true, false),
    { initialProps: { ready: false, sessionKey: '' } },
  );
  await act(async () => { rerender({ ready: true, sessionKey: 'task-a' }); });
  expect(resize).toHaveBeenCalledOnce();
});

// Codex P2: 回包到了但视口还没长到位时，finish 会挂一个自己的 resize 监听等下一帧；effect
// 不再在元数据刷新时拆监听（否则会放开正在等的开栏），所以被取代的那次必须自己收尾，
// 否则每次快速开合都在 renderer 里留一个永久监听。
it('releases a superseded resize wait instead of leaving its listener behind', async () => {
  let reply!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: vi.fn(() => new Promise<number>((done) => { reply = done; })) } as never;
  const abort = vi.spyOn(AbortController.prototype, 'abort');
  const { rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  await act(async () => { rerender({ collapsed: false }); });
  // The reply arrives before Chromium reaches the target viewport: a poll frame is queued.
  await act(async () => { reply(800); });
  expect(frames.length).toBeGreaterThan(0);
  // Closing supersedes that wait before the viewport ever grew.
  await act(async () => { rerender({ collapsed: true }); });
  abort.mockClear();
  frame();
  expect(abort).toHaveBeenCalled();
});

// Codex P1: 无任务语境的全局页被弹到独立窗口、那个窗口崩了再回来时，自动收起路径已经把
// 当前矩形登记成新基准（窗口不再占着展开宽度），回来这一次也就不是用户开栏，不能再拉宽。
it('does not expand again when a crashed global tab brings the view back', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 400 : 0));
  const settle = vi.fn(async () => undefined);
  window.electronAPI = { windowSidebarExpansion: resize, windowSidebarSettle: settle } as never;
  const hook = (props: { ready: boolean; collapsed: boolean; userToggle: boolean; retract: boolean }) =>
    useSidebarPresentation(root, props.collapsed, props.ready, width, props.userToggle, '',
      false, props.retract, true);
  const { rerender } = renderHook(hook, {
    initialProps: { ready: true, collapsed: true, userToggle: false, retract: true },
  });
  // 用户在 /plugins 亲手展开：这一次占窗口宽度。
  await act(async () => { rerender({ ready: true, collapsed: false, userToggle: true, retract: true }); });
  expect(resize).toHaveBeenCalledWith(800);
  window.innerWidth = 1800;
  frame();
  await act(async () => undefined);
  resize.mockClear();
  // 全局页弹到独立窗口：就绪先消失，面板走自动收起（retractOnUnready=false）并 settle。
  await act(async () => { rerender({ ready: false, collapsed: false, userToggle: false, retract: false }); });
  expect(settle).toHaveBeenCalled();
  // 那个窗口崩了、页签回来：MainLayout 按「崩溃回收不是用户手势」把来源置回非用户，
  // 所以这一次也不能再拉宽。用户主动合并（reason=merge）仍按用户开栏处理。
  await act(async () => { rerender({ ready: true, collapsed: false, userToggle: false, retract: false }); });
  expect(resize).not.toHaveBeenCalled();
});

it('keeps the standalone width when a readiness gap lands on another task passively', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { result, rerender } = renderHook(
    ({ ready, session, userToggle }) => useSidebarPresentation(root, false, ready, () => 400, userToggle, session),
    { initialProps: { ready: true, session: 'task-a', userToggle: true } },
  );
  await act(async () => undefined);
  expect(resize).toHaveBeenCalledExactlyOnceWith(400);
  // 设置页接管：收回窗口，sessionKey 在这期间会被清空。
  await act(async () => { rerender({ ready: false, session: '', userToggle: true }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  resize.mockClear();
  // 空档里由系统岛跳到任务 B：被动落回，窗口保持独立宽度。
  await act(async () => { rerender({ ready: true, session: 'task-b', userToggle: false }); });
  expect(resize).not.toHaveBeenCalled();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 800 });
});

// Bug: 空档里被清空的 sessionKey 不能顶替原任务；同一任务从设置页回来仍要重新展开。
it('keeps the pre-gap task when the readiness gap clears the session key', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(
    ({ ready, session }) => useSidebarPresentation(root, false, ready, () => 400, false, session),
    { initialProps: { ready: true, session: 'task-a' } },
  );
  await act(async () => undefined);
  expect(resize).toHaveBeenCalledExactlyOnceWith(400);
  await act(async () => { rerender({ ready: false, session: '' }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  resize.mockClear();
  await act(async () => { rerender({ ready: true, session: 'task-a' }); });
  expect(resize).toHaveBeenLastCalledWith(400);
});

// Bug: 空档期间用户直接点名展开（userToggle=true）时，落回哪台任务都要展开。
it('expands when a readiness gap ends in a direct reveal', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(
    ({ ready, session, userToggle }) => useSidebarPresentation(root, false, ready, () => 400, userToggle, session),
    { initialProps: { ready: true, session: 'task-a', userToggle: true } },
  );
  await act(async () => undefined);
  await act(async () => { rerender({ ready: false, session: '', userToggle: true }); });
  resize.mockClear();
  await act(async () => { rerender({ ready: true, session: 'task-b', userToggle: true }); });
  expect(resize).toHaveBeenLastCalledWith(400);
});

// Bug: 首帧由视图强制的程序展示（Orca workers）在启动时和「存档恢复展开」走了同一条
// 路径，把窗口宽度也一起占了；程序展示只该把面板放出来。
it('keeps the window width when the first frame reveal is forced by the view', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { result } = renderHook(() =>
    useSidebarPresentation(root, false, true, () => 400, false, 'task-a', true));
  await act(async () => undefined);
  expect(resize).not.toHaveBeenCalled();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 800 });
});

// Bug: 分离窗口合并回主窗时只有来源翻转；面板本来就开着，宽度在分离时已交还窗口。
// 上一版把这次合并当成被动落回，合并回来的侧栏被挤在独立窗口的宽度里。
it('expands when a detached sidebar merges back as a user action', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  window.electronAPI = { windowSidebarExpansion: resize } as never;
  const { rerender } = renderHook(
    ({ ready, collapsed, userToggle }) =>
      useSidebarPresentation(root, collapsed, ready, () => 400, userToggle, 'task-a', true),
    { initialProps: { ready: true, collapsed: false, userToggle: false } },
  );
  // 首帧由视图强制展示：面板放出来，但不占窗口宽度。
  await act(async () => undefined);
  expect(resize).not.toHaveBeenCalled();
  // 弹出到独立窗口：面板失去就绪，宽度交还窗口。
  await act(async () => { rerender({ ready: false, collapsed: false, userToggle: false }); });
  expect(resize).toHaveBeenLastCalledWith(0);
  resize.mockClear();
  // 合并回主窗的那一帧：来源还是被动，不能自己拉宽。
  await act(async () => { rerender({ ready: true, collapsed: false, userToggle: false }); });
  expect(resize).not.toHaveBeenCalled();
  // 主窗的合并 effect 随后把来源翻成用户开栏：这一次要真的拉宽。
  await act(async () => { rerender({ ready: true, collapsed: false, userToggle: true }); });
  expect(resize).toHaveBeenCalledExactlyOnceWith(400);
});

// Bug: 关掉全局页签桶的最后一个页签时，全局具名页在同一帧变成不可用。上一版把这帧
// 读成「离开就绪区间」，调 resize(0) 把窗口收窄；间接收起应保持窗口矩形。
it('settles without shrinking when the pane is collapsed as readiness disappears', async () => {
  const resize = vi.fn(async (requested: number) => (requested > 0 ? 401 : 0));
  const settle = vi.fn(async () => undefined);
  window.electronAPI = { windowSidebarExpansion: resize, windowSidebarSettle: settle } as never;
  const { rerender } = renderHook(
    ({ ready, collapsed }) =>
      useSidebarPresentation(root, collapsed, ready, () => 400, true, '', false, false),
    { initialProps: { ready: true, collapsed: true } },
  );
  await act(async () => { rerender({ ready: true, collapsed: false }); });
  expect(resize).toHaveBeenCalledExactlyOnceWith(400);
  resize.mockClear();
  await act(async () => { rerender({ ready: false, collapsed: true }); });
  expect(resize).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledOnce();
});

// Bug: 面板已经开着时再来一次幂等被动 open（MCP App 的 cindy.ui.open），来源被改写成
// 「程序强制展示」，设置页往返回来后按 forcedReveal 跳过展开，窗口停在收起后的宽度。
it('rewrites the reveal source only when the request really changes the pane', () => {
  const passiveOpen = { visibility: 'open' as const, userInitiated: false };
  expect(rewritesRevealSource({ ...passiveOpen, collapsed: true })).toBe(true);
  expect(rewritesRevealSource({ ...passiveOpen, collapsed: false })).toBe(false);
  const passiveClose = { visibility: 'close' as const, userInitiated: false };
  expect(rewritesRevealSource({ ...passiveClose, collapsed: false })).toBe(true);
  expect(rewritesRevealSource({ ...passiveClose, collapsed: true })).toBe(false);
  // 用户手势照旧改写，合并回来的来源翻转还靠它。
  expect(rewritesRevealSource({ visibility: 'open', userInitiated: true, collapsed: false })).toBe(true);
});

// Bug: 后台任务的旧档在写之前没读，写完再读只会读到「已展开」，程序开栏永远记不上被动
// 展示；用户第一次落地那个任务时被当成用户开栏，窗口被自动化拉宽。
it('marks a background program open passive only when the pane was really closed', () => {
  const open = { visibility: 'open' as const, userInitiated: false };
  expect(passiveRevealOnBackgroundOpen({ ...open, wasCollapsed: true })).toBe(true);
  // 已经开着的幂等请求：那格记忆是用户自己开的那次，落地时该照常占窗口宽度。
  expect(passiveRevealOnBackgroundOpen({ ...open, wasCollapsed: false })).toBe(false);
  // 用户手势跨任务开栏走自己的来源，不算被动展示。
  expect(passiveRevealOnBackgroundOpen({ ...open, userInitiated: true, wasCollapsed: true })).toBe(false);
  // 收起不是开栏，标记由 close 分支清掉。
  expect(passiveRevealOnBackgroundOpen({ visibility: 'close', userInitiated: false, wasCollapsed: false })).toBe(false);
});
