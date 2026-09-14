import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHomeProjectChildOffsets,
  findHomeProjectChildIndex,
  resolveHomeProjectChildAnchor,
  resolveHomeProjectChildWindow,
  shouldWindowHomeProjectChildren,
} from '@/session/homeProjectChildWindow';

describe('home project child window', () => {
  it('marks a large expanded group eligible for windowing before layout tracking is ready', () => {
    const offsets = buildHomeProjectChildOffsets(Array.from({ length: 200 }, () => 78));

    expect(shouldWindowHomeProjectChildren({
      collapsed: false,
      itemCount: 200,
      scrollTrackingAvailable: true,
      threshold: 20,
    })).toBe(true);

    const initialRange = resolveHomeProjectChildWindow({
      anchor: 0,
      childOffsets: offsets,
      overscan: 4,
      windowSize: 15,
    });
    expect(initialRange.start).toBe(0);
    expect(initialRange.end).toBeLessThan(200);
    expect(initialRange.trailingSpacerHeight).toBeGreaterThan(0);
  });

  it('keeps off-screen child content unmounted and anchors it once visible', () => {
    const childOffsets = buildHomeProjectChildOffsets(Array.from({ length: 112 }, () => 78));

    expect(resolveHomeProjectChildAnchor({
      childOffsets,
      projectHeaderHeight: 56,
      projectTop: 780,
      shift: 4,
      viewportHeight: 800,
      viewportTop: 0,
    })).toBe(-1);
    expect(resolveHomeProjectChildAnchor({
      childOffsets,
      projectHeaderHeight: 56,
      projectTop: 200,
      shift: 4,
      viewportHeight: 800,
      viewportTop: 500,
    })).toBe(0);
    expect(resolveHomeProjectChildAnchor({
      childOffsets,
      projectHeaderHeight: 56,
      projectTop: 200,
      shift: 4,
      viewportHeight: 800,
      viewportTop: 900,
    })).toBe(8);
  });

  it('does not measure or window ordinary previews and collapsed groups', () => {
    expect(shouldWindowHomeProjectChildren({
      collapsed: false,
      itemCount: 20,
      scrollTrackingAvailable: true,
      threshold: 20,
    })).toBe(false);
    expect(shouldWindowHomeProjectChildren({
      collapsed: true,
      itemCount: 200,
      scrollTrackingAvailable: true,
      threshold: 20,
    })).toBe(false);
  });

  it('keeps layout readiness out of the first-render window gate', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8');
    const setupStart = source.indexOf('const windowingEnabled = shouldWindowHomeProjectChildren({');
    const setupEnd = source.indexOf('const scrollY = homeScrollY;', setupStart);
    const setup = source.slice(setupStart, setupEnd);

    expect(setupStart).toBeGreaterThan(-1);
    expect(setup).not.toContain('projectLayoutReady');
    expect(source).toContain('function HomeProjectWindowAnchorTracker({');
    expect(source).toContain('if (!projectLayoutReady.value) return -1;');
    expect(source).toContain('return resolveHomeProjectChildAnchor({');
    expect(source).toContain('const [windowAnchor, setWindowAnchor] = useState(-1);');
    expect(source).toContain('trailingSpacerHeight: childContentHeight');
    expect(source).toContain('{windowingEnabled && scrollY ? (');
    expect(source).toContain('const renderedSessions = windowingEnabled ? visibleSessions.slice');
    expect(source).toContain('if (!windowingEnabled) return;');
  });

  it('bounds the outer home list window instead of retaining every flat row', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8');

    expect(source).toContain('initialNumToRender={HOME_LIST_INITIAL_RENDER_COUNT}');
    expect(source).toContain('maxToRenderPerBatch={HOME_LIST_RENDER_BATCH_SIZE}');
    expect(source).toContain('updateCellsBatchingPeriod={32}');
    expect(source).toContain('windowSize={HOME_LIST_WINDOW_SIZE}');
  });

  it('locates mixed-height rows without changing their total occupied height', () => {
    const offsets = buildHomeProjectChildOffsets([60, 78, 60, 78, 60, 78]);

    expect(offsets).toEqual([0, 60, 138, 198, 276, 336, 414]);
    expect(findHomeProjectChildIndex(offsets, 0)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 59)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 60)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 275)).toBe(3);

    const range = resolveHomeProjectChildWindow({
      anchor: 3,
      childOffsets: offsets,
      overscan: 1,
      windowSize: 2,
    });
    expect(range).toEqual({
      end: 6,
      leadingSpacerHeight: 138,
      start: 2,
      trailingSpacerHeight: 0,
    });
    expect(
      range.leadingSpacerHeight
      + (offsets[range.end] - offsets[range.start])
      + range.trailingSpacerHeight,
    ).toBe(offsets.at(-1));
  });

  it('keeps a tall expanded automation group inside the same prefix-sum model', () => {
    const offsets = buildHomeProjectChildOffsets([60, 78 + 60 + 78 + 54, 78, 60, 78]);

    expect(findHomeProjectChildIndex(offsets, 59)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 60)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 329)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 330)).toBe(2);
  });

  it('clamps the window at both ends and ignores invalid height estimates', () => {
    const offsets = buildHomeProjectChildOffsets([60, Number.NaN, -1, 78, 60]);

    expect(offsets).toEqual([0, 60, 60, 60, 138, 198]);
    expect(resolveHomeProjectChildWindow({
      anchor: 99,
      childOffsets: offsets,
      overscan: 1,
      windowSize: 2,
    })).toEqual({
      end: 5,
      leadingSpacerHeight: 60,
      start: 3,
      trailingSpacerHeight: 0,
    });
  });
});
