import { describe, expect, it } from 'vitest';
import { buildWideSessionNavLayout } from '@/session/wideSessionNav';

describe('quick-switch panel sizing', () => {
  it.each([600, 744, 852, 1366])('offers switching at width %i without replacing back', (windowWidth) => {
    for (const platform of ['ios', 'android']) {
      const layout = buildWideSessionNavLayout({ windowWidth, windowHeight: 852, platform });
      expect(layout.enabled).toBe(true);
      expect(layout.drawerWidth).toBeLessThanOrEqual(windowWidth - 24);
      expect(layout.drawerWidth).toBeLessThanOrEqual(360);
      expect(layout.drawerWidth).toBeGreaterThan(0);
    }
  });
  it('keeps the existing tablet sizing and fits narrow split windows', () => {
    expect(buildWideSessionNavLayout({ windowWidth: 800 }).drawerWidth).toBe(320);
    expect(buildWideSessionNavLayout({ windowWidth: 1366 }).drawerWidth).toBe(360);
    expect(buildWideSessionNavLayout({ windowWidth: 600 }).drawerWidth).toBe(300);
  });
  it.each([undefined, Number.NaN, -1, 0, 280, 393, 599])('does not open before a valid layout (%s)', (windowWidth) => {
    expect(buildWideSessionNavLayout({ windowWidth }).enabled).toBe(false);
  });
});
