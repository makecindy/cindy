import { describe, expect, it } from 'vitest';
import { keyboardControlRegion, controlRegion, floatingTopRow, sharedStatusRowDrawerTop, windowDivision, type WindowGeometry } from '@/platform/windowGeometry';
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
  // Unit: Duo resize request (2026-10-23). Existing tests cover fixed panes only;
  // dragging beyond either edge must not squeeze the list or message composer away.
  it('clamps manual column widths and reserves at least 400pt for the conversation', () => {
    for (const [requested, expected] of [[100, 240], [360, 360], [900, 420]]) {
      const p = sessionPaneLayout(window(), requested);
      expect(p.sidebarWidth).toBe(expected);
      expect(p.detail.x + p.detail.width).toBe(840);
      expect(p.detail.width).toBeGreaterThanOrEqual(400);
    }
    expect(sessionPaneLayout(window({ width: 820 }), 420).sidebarWidth).toBe(360);
    expect(sessionPaneLayout(window({ width: 430 }), 420).sidebarWidth).toBe(0);
  });
  it('keeps an actual reserved fold fixed even with a manual width', () => {
    const p = sessionPaneLayout(window({ regions: [{ kind: 'division', x: 360, y: 0, width: 32, height: 700 }] }), 240);
    expect(p.sidebarWidth).toBe(360);
    expect(p.detail.x).toBe(392);
    expect(p.resizeBounds).toBeNull();
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
  const folded = window({ width: 600, barEdge: 'none', regions: [{ kind: 'division', x: 0, y: 300, width: 600, height: 30 }] });
  // Unit: 2026-10-23 product correction. A landscape half-fold must use the
  // ordinary full-width desktop, even though the window reports a division.
  it('never splits a landscape desktop into video and trackpad', () => {
    for (const region of [
      { kind: 'division' as const, x: 430, y: 0, width: 30, height: 700 },
      { kind: 'division' as const, x: 0, y: 300, width: 900, height: 30 },
    ]) {
      expect(foldDesktopLayout(window({ regions: [region] }), 0, 240, false)).toBeNull();
      expect(foldDesktopLayout(window({ regions: [region] }), 200, 180, true)).toBeNull();
    }
  });
  it('keeps video above the hinge and controls below it', () => {
    const layout = foldDesktopLayout(folded, 0, 240, false)!;
    expect(layout.media).toEqual({ x: 0, y: 0, width: 540, height: 300 });
    expect(layout.controls).toEqual({ x: 0, y: 330, width: 540, height: 350 });
  });
  it('keeps an input sheet in the upper region when the keyboard covers the lower half', () => {
    expect(keyboardControlRegion(folded, 350)).toEqual({ x: 0, y: 0, width: 540, height: 300 });
  });
  // Unit: 2026-10-23 Duo feedback replaces the old upper-screen fallback.
  // With 100pt remaining below the hinge, the 60pt keyboard toolbar must stay
  // above the system keyboard in that lower screen, leaving video unchanged.
  it('keeps the keyboard toolbar below the hinge even with less than 140pt remaining', () => {
    const layout = foldDesktopLayout(folded, 270, 60, true)!;
    expect(layout.controls).toEqual({ x: 0, y: 330, width: 540, height: 100 });
    expect(layout.media).toEqual({ x: 0, y: 0, width: 540, height: 300 });
  });
  it('keeps controls above a bottom camera occlusion', () => {
    const layout = foldDesktopLayout(window({ ...folded, regions: [
      ...folded.regions, { kind: 'occlusion', x: 0, y: 600, width: 900, height: 100 },
    ] }), 0, 240, false)!;
    expect(layout.controls.y + layout.controls.height).toBe(600);
  });
  it('returns to ordinary layout after unfolding without a synthetic half-screen split', () => {
    expect(foldDesktopLayout(window(), 0, 240, false)).toBeNull();
  });
});

// Regression: #7008. Duo portrait's top bar shares the status row, so the task-list drawer header
// sat 72pt too low under safeArea.top; measured on the Duo simulator (safe top 82, bar height 82).
describe('task-list drawer top when the system bar shares the status row', () => {
  it('lands the header on the shared row for Duo and leaves ordinary bars alone', () => {
    expect(sharedStatusRowDrawerTop(82, 82)).toBe(10);
    expect(sharedStatusRowDrawerTop(40, 82)).toBe(0);
    expect(sharedStatusRowDrawerTop(103, 59)).toBeUndefined();
    expect(sharedStatusRowDrawerTop(0, 82)).toBeUndefined();
  });
});

// Regression: Duo file preview (2026-10-29). Its floating close/title/menu row sat under the whole
// status area in portrait, and against the top screen edge (clipped) beside the landscape rail.
describe('floating top row beside the Duo status area', () => {
  const portrait = (patch: Partial<WindowGeometry> = {}) => window({ width: 662, height: 942, barEdge: 'none',
    insets: { top: 82, left: 0, right: 0, bottom: 20 },
    regions: [{ kind: 'occlusion', x: 520, y: 0, width: 142, height: 82 }], ...patch });
  it('shares the status row in portrait, ending before the status area', () => {
    expect(floatingTopRow(portrait(), 44)).toEqual({ top: 26, left: 12, right: 150, sharedStatusRow: true });
  });
  it('keeps the row below the status area for ordinary bars, other reservations and narrow rows', () => {
    const below = { top: 82, left: 12, right: 12, sharedStatusRow: false };
    expect(floatingTopRow(portrait({ regions: [] }), 44)).toEqual(below);
    expect(floatingTopRow(portrait({ reservedRegionsSupported: false }), 44)).toEqual(below);
    expect(floatingTopRow(portrait({ regions: [...portrait().regions, { kind: 'occlusion', x: 280, y: 20, width: 100, height: 40 }] }), 44)).toEqual(below);
    expect(floatingTopRow(portrait({ width: 300, regularWidth: false, regions: [{ kind: 'occlusion', x: 160, y: 0, width: 140, height: 82 }] }), 44)).toMatchObject({ sharedStatusRow: false });
  });
  it('keeps a margin from the top edge beside a vertical system bar', () => {
    expect(floatingTopRow(window(), 44)).toEqual({ top: 12, left: 12, right: 72, sharedStatusRow: false });
  });
});
