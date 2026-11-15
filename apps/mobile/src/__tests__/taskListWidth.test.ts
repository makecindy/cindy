import { describe, expect, it } from 'vitest';
import { sessionPaneLayout } from '@/session/sessionPaneLayout';
import { buildWideSessionNavLayout } from '@/session/wideSessionNav';
import type { WindowGeometry } from '@/platform/windowGeometry';

const landscape: WindowGeometry = { width: 951, height: 669,
  insets: { left: 0, right: 84, top: 0, bottom: 0 }, regularWidth: true,
  regularHeight: true, barEdge: 'right', regions: [], reservedRegionsSupported: true };

describe('one visible task-list width across Duo rotation', () => {
  it.each([null, 300, 340, 380, 400, 420, 240, 529])('keeps the same settled width for preference %s', preferredWidth => {
    const portrait = buildWideSessionNavLayout({ windowWidth: 669, windowHeight: 951,
      trailingReserve: 140, preferredWidth });
    const column = sessionPaneLayout(landscape, preferredWidth);
    expect(portrait.drawerWidth).toBe(column.sidebarWidth);
    expect(portrait.resizeBounds).toEqual(column.resizeBounds);
    expect(column.detail.width).toBeGreaterThanOrEqual(400);
    if (preferredWidth === null) expect(column.sidebarWidth).toBe(400);
  });
});
