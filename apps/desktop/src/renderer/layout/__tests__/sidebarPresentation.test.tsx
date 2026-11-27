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

// #11561 review: a resize after rejection must not revive the waiter and
// overwrite the fallback; the previous assertion covered only immediate failure. Unit tier.
it('releases the frozen layout if the native request fails', async () => {
  window.electronAPI = { windowSidebarExpansion: vi.fn(async () => { throw new Error('unavailable'); }) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  await act(async () => { rerender({ collapsed: false }); });
  expect(result.current).toEqual({ collapsed: false, instant: false });
  act(() => { window.innerWidth = 1800; window.dispatchEvent(new Event('resize')); });
  expect(result.current).toEqual({ collapsed: false, instant: false });
});

// #11561 review: restored native window bounds can move opposite to the requested
// direction. Existing tests only exercise positive open growth. Unit tier.
it('accepts an authoritative negative growth when opening', async () => {
  let reply!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: () => new Promise<number>((done) => { reply = done; }) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  await act(async () => { reply(-200); });
  act(() => { window.innerWidth = 800; window.dispatchEvent(new Event('resize')); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 600 });
});

// #11561 review: a delayed IPC reply must retain the frozen layout and still
// allow its authoritative resize; existing tests do not delay beyond one second. Unit tier.
it('waits for a delayed reply before starting the resize timeout', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  let reply!: (delta: number) => void;
  window.electronAPI = { windowSidebarExpansion: () => new Promise<number>((done) => { reply = done; }) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  now.mockReturnValue(1500);
  frame();
  expect(result.current.frozenWidth).toBe(800);
  await act(async () => { reply(400); });
  act(() => { window.innerWidth = 1400; window.dispatchEvent(new Event('resize')); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1200 });
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

// Linux regression (#11560): on Wayland the compositor pushes the new viewport to
// the renderer before the windowSidebarExpansion invoke reply returns (setBounds
// blocks the main thread ~3-7ms). The hook must unfreeze on that early viewport
// change — armed before the IPC call — rather than wait for the reply, or the
// frozen layout lingers an extra frame and the open direction shows a blank band.
it('unfreezes on the viewport resize that lands before the open reply', async () => {
  const resolvers: ((delta: number) => void)[] = [];
  window.electronAPI = { windowSidebarExpansion: vi.fn(
    () => new Promise<number>((done) => { resolvers.push(done); }),
  ) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  expect(result.current.frozenWidth).toBe(800);
  // Viewport grows to the predicted target before the invoke replies.
  window.innerWidth = 1800;
  act(() => { window.dispatchEvent(new Event('resize')); });
  expect(result.current).toEqual({ collapsed: false, instant: true, expandedWidth: 1600 });
  // A reply arriving after settle is a no-op.
  await act(async () => { resolvers[0](800); });
  expect(result.current.collapsed).toBe(false);
});

// Codex review P2 on #11561: a superseded invocation rejecting after the newer
// reply armed its resize listener must not detach that listener — the release
// ref already belongs to the newer transition, so a late rejection must no-op.
it('a late rejection from a superseded request leaves the active listener armed', async () => {
  const resolvers: ((delta: number) => void)[] = [];
  const rejectors: ((err: Error) => void)[] = [];
  window.electronAPI = { windowSidebarExpansion: vi.fn(
    () => new Promise<number>((done, reject) => { resolvers.push(done); rejectors.push(reject); }),
  ) } as never;
  const { result, rerender } = renderHook(({ collapsed }) => useSidebarPresentation(root, collapsed, true, width),
    { initialProps: { collapsed: true } });
  rerender({ collapsed: false });
  rerender({ collapsed: true });
  // The newer request (close) replies first and arms its resize listener.
  await act(async () => { resolvers[1](-400); });
  expect(result.current.frozenWidth).toBe(800);
  // The superseded open request only rejects now.
  await act(async () => { rejectors[0](new Error('superseded')); });
  act(() => {
    window.innerWidth = 600;
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ collapsed: true, instant: true });
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
