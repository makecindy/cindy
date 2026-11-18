import { describe, expect, it } from 'vitest';
import { placeTrayCard, TRAY_CARD_GAP } from '../trayCardPlacement';

// User report on PR #11277 (2026-11-18): opened from an icon in the Windows overflow flyout,
// the tray card's bottom covered the top of the icon, unlike Feishu's card. The card was placed
// 10px from the icon's centre, inside a 32px cell. Entry: placeTrayCard, the one placement
// windowsPanel.ts uses. Unit tier: pure geometry, no Electron. Minimal failing input: the first
// row, a 32px overflow cell low on a 1080px screen.
const area = { x: 0, y: 0, width: 1920, height: 1032 };
const card = { width: 332, height: 660 };

describe('placeTrayCard', () => {
  it.each([
    { where: 'overflow flyout cell', anchor: { x: 1700, y: 950, width: 32, height: 32 }, bottomOf: 950 - TRAY_CARD_GAP },
    { where: 'pointer without an icon', anchor: { x: 1700, y: 950, width: 0, height: 0 }, bottomOf: 950 - TRAY_CARD_GAP },
  ])('keeps the card clear of the $where below it', ({ anchor, bottomOf }) => {
    const placed = placeTrayCard({ anchor, area, ...card });
    expect(placed.y + placed.height).toBe(bottomOf);
    expect(placed.x + placed.width / 2).toBe(anchor.x + anchor.width / 2);
  });

  it('opens below an icon on a top taskbar, clear of it', () => {
    const placed = placeTrayCard({ anchor: { x: 1700, y: 4, width: 32, height: 32 }, area: { ...area, y: 48 }, ...card });
    expect(placed.y).toBe(48);
    const lower = placeTrayCard({ anchor: { x: 1700, y: 60, width: 32, height: 32 }, area: { ...area, y: 48 }, ...card });
    expect(lower.y).toBe(60 + 32 + TRAY_CARD_GAP);
  });

  it('stays inside the work area at the screen edge', () => {
    const placed = placeTrayCard({ anchor: { x: 1900, y: 1040, width: 24, height: 40 }, area, ...card });
    expect(placed.x + placed.width).toBe(area.width);
    expect(placed.y + placed.height).toBe(area.height);
  });
});
