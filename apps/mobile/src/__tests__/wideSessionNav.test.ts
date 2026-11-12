import { describe, expect, it } from 'vitest';
import { buildWideSessionNavLayout } from '@/session/wideSessionNav';

describe('quick-switch panel sizing', () => {
  it.each([600, 744, 852, 1366])('offers switching at width %i without replacing back', (windowWidth) => {
    for (const platform of ['ios', 'android']) {
      const layout = buildWideSessionNavLayout({ windowWidth, windowHeight: 852, platform });
      expect(layout.enabled).toBe(true);
      expect(layout.drawerWidth).toBeLessThanOrEqual(windowWidth - 96);
      expect(layout.drawerWidth).toBeGreaterThan(0);
      expect(layout.resizeBounds).toEqual({ min: 300, max: 420 });
    }
  });
  // User request 2026-11-06: on an iPad mini the drawer was ~300pt, narrower than
  // the phone's own list. Default to at least a regular phone's portrait width.
  it('defaults to a phone-width list on every wide window', () => {
    for (const windowWidth of [600, 744, 800, 1366]) {
      expect(buildWideSessionNavLayout({ windowWidth }).drawerWidth).toBe(400);
    }
  });
  it('follows the shared width the user dragged, clamped to leave a tappable scrim', () => {
    expect(buildWideSessionNavLayout({ windowWidth: 744, preferredWidth: 520 }).drawerWidth).toBe(420);
    expect(buildWideSessionNavLayout({ windowWidth: 744, preferredWidth: 900 }).drawerWidth).toBe(420);
    // Both surfaces now share the same minimum, including older preferences.
    expect(buildWideSessionNavLayout({ windowWidth: 744, preferredWidth: 240 }).drawerWidth).toBe(300);
    expect(buildWideSessionNavLayout({ windowWidth: 744, preferredWidth: null }).drawerWidth).toBe(400);
    expect(buildWideSessionNavLayout({ windowWidth: 744, preferredWidth: Number.NaN }).drawerWidth).toBe(400);
  });
  // Duo portrait: the status area shares the top row, so a settled drawer stops
  // before it; only the drag on toward full screen passes under it.
  it('keeps the settled drawer clear of a top trailing status area', () => {
    expect(buildWideSessionNavLayout({ windowWidth: 669, trailingReserve: 320, preferredWidth: 420 }).drawerWidth).toBe(349);
    expect(buildWideSessionNavLayout({ windowWidth: 669, trailingReserve: 140 }).resizeBounds).toEqual({ min: 300, max: 420 });
    expect(buildWideSessionNavLayout({ windowWidth: 669, trailingReserve: 140, preferredWidth: 600 }).drawerWidth).toBe(420);
    expect(buildWideSessionNavLayout({ windowWidth: 669, trailingReserve: 40 }).resizeBounds).toEqual({ min: 300, max: 420 });
    expect(buildWideSessionNavLayout({ windowWidth: 669, trailingReserve: 0 }).resizeBounds).toEqual({ min: 300, max: 420 });
  });
  it.each([undefined, Number.NaN, -1, 0, 280, 393, 599])('does not open before a valid layout (%s)', (windowWidth) => {
    const layout = buildWideSessionNavLayout({ windowWidth });
    expect(layout.enabled).toBe(false);
    expect(layout.resizeBounds).toBeNull();
  });
});
