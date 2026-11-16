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
