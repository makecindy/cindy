import { describe, expect, it } from 'vitest';
import { keyboardControlRegion, controlRegion, windowDivision, type WindowGeometry } from '@/platform/windowGeometry';
import { foldDesktopLayout } from '@/remote-desktop/foldDesktopLayout';
import { sessionPaneLayout } from '@/session/sessionPaneLayout';

const window = (patch: Partial<WindowGeometry> = {}): WindowGeometry => ({
  width: 900, height: 700, insets: { top: 0, left: 0, right: 60, bottom: 20 },
  regularWidth: true, regularHeight: true, barEdge: 'right', regions: [], reservedRegionsSupported: true, ...patch,
});
describe('adaptive window regions', () => {
  it('reserves independent safe edges and room for both navigation and content', () => {
    const p = sessionPaneLayout(window());
    expect(p.persistent).toBe(true);
    expect(p.detail.x).toBe(p.sidebarWidth);
    expect(p.detail.x + p.detail.width).toBe(840);
  });
  it('collapses in either side of Split View, regardless of phone/tablet identity', () => {
    for (const insets of [{ top: 0, left: 60, right: 0, bottom: 20 }, { top: 0, left: 0, right: 60, bottom: 20 }]) {
      const p = sessionPaneLayout(window({ width: 430, insets }));
      expect(p.persistent).toBe(false);
      expect(p.detail.width).toBe(370);
    }
  });
  it('aligns two panes to an off-centre fold instead of assuming equal halves', () => {
    const p = sessionPaneLayout(window({ regions: [{ kind: 'division', x: 360, y: 0, width: 32, height: 700 }] }));
    expect(p.persistent).toBe(true);
    expect(p.sidebarWidth).toBe(360);
    expect(p.detail.x).toBe(392);
    expect(p.detail.width).toBe(448);
  });
  it('uses the lower region for controls and leaves the hinge untouchable', () => {
    const g = window({ regions: [{ kind: 'division', x: 0, y: 300, width: 900, height: 30 }] });
    expect(windowDivision(g)?.first.height).toBe(300);
    expect(controlRegion(g)).toEqual({ x: 0, y: 330, width: 840, height: 350 });
    expect(sessionPaneLayout(g).persistent).toBe(false);
  });
  it('moves a floating group away from an active camera without reserving the whole screen', () => {
    const area = controlRegion(window({ regions: [{ kind: 'occlusion', x: 390, y: 0, width: 60, height: 40 }] }));
    expect(area).toEqual({ x: 0, y: 40, width: 840, height: 640 });
  });
  it('ignores a fold outside this window and restores ordinary geometry when flat', () => {
    const g = window({ regions: [{ kind: 'division', x: 950, y: 0, width: 20, height: 700 }] });
    expect(windowDivision(g)).toBeNull();
    expect(controlRegion(window())).toEqual({ x: 0, y: 0, width: 840, height: 680 });
  });
});


describe('folded desktop keyboard geometry', () => {
  const folded = window({ regions: [{ kind: 'division', x: 0, y: 300, width: 900, height: 30 }] });
  it('keeps video above the hinge and controls below it', () => {
    const layout = foldDesktopLayout(folded, 0, 240, false)!;
    expect(layout.media).toEqual({ x: 0, y: 0, width: 840, height: 300 });
    expect(layout.controls).toEqual({ x: 0, y: 330, width: 840, height: 350 });
  });
  it('keeps an input sheet in the upper region when the keyboard covers the lower half', () => {
    expect(keyboardControlRegion(folded, 350)).toEqual({ x: 0, y: 0, width: 840, height: 300 });
  });
  it('moves custom keys above the fold when the system keyboard covers the lower region', () => {
    const layout = foldDesktopLayout(folded, 350, 180, true)!;
    expect(layout.controls).toEqual({ x: 0, y: 0, width: 840, height: 300 });
    expect(layout.media.height).toBe(120);
  });
  it('keeps controls above a bottom camera occlusion', () => {
    const layout = foldDesktopLayout(window({ regions: [
      ...folded.regions, { kind: 'occlusion', x: 0, y: 600, width: 900, height: 100 },
    ] }), 0, 240, false)!;
    expect(layout.controls.y + layout.controls.height).toBe(600);
  });
  it('returns to ordinary layout after unfolding without a synthetic half-screen split', () => {
    expect(foldDesktopLayout(window(), 0, 240, false)).toBeNull();
  });
});
