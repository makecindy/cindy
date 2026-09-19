import { expect, it } from 'vitest';
import { isWaylandDesktop, selectPortalSource, waylandDesktopSize } from '../waylandCapture';

it('isolates Wayland and XWayland hosts from X11, macOS and Windows', () => {
  expect(isWaylandDesktop('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
  expect(isWaylandDesktop('linux', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(true);
  expect(isWaylandDesktop('linux', { XDG_SESSION_TYPE: 'x11' })).toBe(false);
  expect(isWaylandDesktop('darwin', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(false);
  expect(isWaylandDesktop('win32', {})).toBe(false);
});
it('uses only the single screen explicitly selected by the portal, without guessing monitor IDs', () => {
  const selected = { id: 'screen:0:0', display_id: '' };
  expect(selectPortalSource([selected])).toBe(selected);
  expect(selectPortalSource([])).toBeNull();
  expect(selectPortalSource([selected, { id: 'screen:1:0' }])).toBeNull();
  expect(selectPortalSource([{ id: 'window:1:0' }])).toBeNull();
});

it('preserves a 16:10 desktop aspect ratio instead of exposing JPEG edges behind pillarboxed video', () => {
  expect(waylandDesktopSize([{ bounds: { x: 0, y: 0, width: 1600, height: 1000 } }])).toEqual({
    width: 1600,
    height: 1000,
  });
});
it('includes negative output positions and monitor gaps in the whole-desktop geometry', () => {
  expect(
    waylandDesktopSize([
      { bounds: { x: -1200, y: -200, width: 1000, height: 1600 } },
      { bounds: { x: 0, y: 0, width: 1600, height: 1000 } },
    ]),
  ).toEqual({ width: 2800, height: 1600 });
});
