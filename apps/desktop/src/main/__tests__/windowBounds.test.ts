import { describe, expect, it } from 'vitest';

import {
  isPointInWindowBounds,
  isPointInsideAnyWindow,
  resolveSessionDragPreviewBounds,
  resolveWindowBoundsNearPoint,
} from '../windowBounds';

const bounds = { x: 10, y: 20, width: 100, height: 80 };

describe('window bounds', () => {
  it('uses a half-open rectangle', () => {
    expect(isPointInWindowBounds({ x: 10, y: 20 }, bounds)).toBe(true);
    expect(isPointInWindowBounds({ x: 109, y: 99 }, bounds)).toBe(true);
    expect(isPointInWindowBounds({ x: 110, y: 99 }, bounds)).toBe(false);
    expect(isPointInWindowBounds({ x: 109, y: 100 }, bounds)).toBe(false);
  });

  it('recognizes any app window as an in-app drop target', () => {
    expect(
      isPointInsideAnyWindow({ x: 250, y: 150 }, [
        bounds,
        { x: 200, y: 100, width: 80, height: 80 },
      ]),
    ).toBe(true);
    expect(isPointInsideAnyWindow({ x: 500, y: 500 }, [bounds])).toBe(false);
  });

  it('places a detached task window with its title bar near the release point', () => {
    expect(
      resolveWindowBoundsNearPoint(
        { x: 1800, y: 200 },
        { width: 1200, height: 800 },
        { x: 1440, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 1720, y: 176, width: 1200, height: 800 });
  });

  it('clamps detached windows to the target display work area', () => {
    expect(
      resolveWindowBoundsNearPoint(
        { x: 3300, y: 1000 },
        { width: 1200, height: 800 },
        { x: 1440, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 2160, y: 280, width: 1200, height: 800 });
  });

  it('shrinks oversized detached windows to remain fully visible', () => {
    expect(
      resolveWindowBoundsNearPoint(
        { x: -1200, y: 200 },
        { width: 1600, height: 1000 },
        { x: -1440, y: 0, width: 1440, height: 900 },
      ),
    ).toEqual({ x: -1440, y: 0, width: 1440, height: 900 });
  });

  it('places the transient drag preview below the cursor and clamps it to the display', () => {
    expect(
      resolveSessionDragPreviewBounds(
        { x: 1800, y: 200 },
        { x: 1440, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 1808, y: 208, width: 320, height: 68 });
    expect(
      resolveSessionDragPreviewBounds(
        { x: 3350, y: 1060 },
        { x: 1440, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 3040, y: 1012, width: 320, height: 68 });
  });
});
