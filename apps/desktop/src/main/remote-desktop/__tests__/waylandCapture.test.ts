import { expect, it } from 'vitest';
import {
  isWaylandDesktop,
  selectPortalSource,
  waylandDesktopSize,
  xwaylandSessionEvidence,
} from '../waylandCapture';

it('flags X11 Electron under a Wayland compositor even when XDG_SESSION_TYPE is missing (#9712)', () => {
  // The reported shell had only DISPLAY; the compositor's socket was the only Wayland signal.
  expect(
    xwaylandSessionEvidence('x11', { DISPLAY: ':0' }, ['wayland-1', 'wayland-1.lock']),
  ).toEqual(['socket wayland-1']);
  expect(xwaylandSessionEvidence('x11', { XDG_SESSION_TYPE: 'wayland' }, [])).toEqual([
    'XDG_SESSION_TYPE=wayland',
  ]);
  expect(
    xwaylandSessionEvidence('x11', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, ['bus']),
  ).toEqual([]);
  expect(
    xwaylandSessionEvidence('wayland', { XDG_SESSION_TYPE: 'wayland' }, ['wayland-0']),
  ).toEqual([]);
});

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
