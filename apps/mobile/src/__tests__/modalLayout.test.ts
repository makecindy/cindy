import { describe, expect, it } from 'vitest';
import { modalLayout } from '@/platform/modalLayout';
import type { WindowGeometry } from '@/platform/windowGeometry';

const window: WindowGeometry = { width: 956, height: 670, regularWidth: true, regularHeight: true,
  insets: { top: 24, right: 84, bottom: 34, left: 0 }, barEdge: 'right',
  regions: [], reservedRegionsSupported: true };
describe('custom modal bounds', () => {
  it('floats with margins and a bounded width instead of a partial-width bottom sheet', () => {
    const { floating, region } = modalLayout(window);
    expect(floating).toBe(true);
    expect(region.width).toBe(560);
    expect(region.x - window.insets.left).toBe(window.width - window.insets.right - region.x - region.width);
    expect(region.y).toBeGreaterThan(window.insets.top);
    expect(region.y + region.height).toBeLessThan(window.height - window.insets.bottom);
  });
  it('keeps the whole panel above the keyboard in a short landscape window', () => {
    const { region } = modalLayout({ ...window, height: 466 }, 260);
    expect(region.y + region.height).toBeLessThanOrEqual(206);
    expect(region.height).toBeGreaterThan(0);
  });
  it('stays within one fold region', () => {
    const { region } = modalLayout({ ...window, regions: [{kind: 'division', x: 460, y: 0, width: 20, height: 670}] });
    expect(region.x).toBeGreaterThanOrEqual(480);
    expect(region.x + region.width).toBeLessThanOrEqual(872);
  });
  it('retains bottom sheet presentation on compact portrait phones', () => {
    expect(modalLayout({ ...window, width: 390, height: 844, barEdge: 'none' }).floating).toBe(false);
  });
});
