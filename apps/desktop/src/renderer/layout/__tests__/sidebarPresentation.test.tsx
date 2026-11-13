// @vitest-environment jsdom
/** Unit timing regression for useSidebarPresentation: opening must not compress chat
 * between the native IPC reply and viewport resize. LayoutRoot tests alone do not control
 * these independent deliveries; delay resize after resolving one open request.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSidebarPresentation } from '../sidebarPresentation';

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
  frame();
  expect(result.current.collapsed).toBe(true);
  expect(result.current.frozenWidth).toBe(800);
  window.innerWidth = 1800;
  frame();
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1600 });
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
