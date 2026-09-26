import { describe, expect, it } from 'vitest';
import { resolveWorkspacePickerFrame } from '@/session/workspacePickerPlacement';

const host = { x: 16, y: 112, width: 380, height: 700 };
const anchor = { x: 24, y: 712, width: 364, height: 44 };

describe('workspace picker placement (#5013)', () => {
  it('keeps the popup above a low anchor and aligned to its measured width', () => {
    expect(resolveWorkspacePickerFrame(anchor, host, 4)).toEqual({
      left: 8, width: 364, bottom: 104, maxHeight: 336,
    });
  });

  it('opens below a selector near the top bar instead of collapsing the list', () => {
    const frame = resolveWorkspacePickerFrame({ ...anchor, y: host.y + 20 }, host, 4);
    expect(frame.top).toBe(68);
    expect(frame.maxHeight).toBe(336);
    expect(frame.bottom).toBeUndefined();
  });

  it('uses the visible host when an expanded composer leaves neither side large enough', () => {
    const frame = resolveWorkspacePickerFrame(
      { ...anchor, y: host.y + 140 }, { ...host, height: 300 }, 4,
    );
    expect(frame.top).toBe(4);
    expect(frame.maxHeight).toBe(292);
  });

  it('gives the entire viewport to scrollable options even below fixed-action height', () => {
    const frame = resolveWorkspacePickerFrame(
      { ...anchor, y: host.y + 24 }, { ...host, height: 100 }, 4,
    );
    expect(frame.top).toBe(4);
    expect(frame.maxHeight).toBe(92);
  });

  it('repositions after keyboard resize without retaining an obsolete bottom offset', () => {
    const before = resolveWorkspacePickerFrame(anchor, host, 4);
    const after = resolveWorkspacePickerFrame(
      { ...anchor, y: host.y + 12 }, { ...host, height: 420 }, 4,
    );
    expect(before.bottom).toBeDefined();
    expect(after.bottom).toBeUndefined();
    expect(after.top).toBe(60);
    expect(after.maxHeight).toBe(336);
  });

  it('stays below the top bar and above the keyboard for scrolled and offscreen anchors', () => {
    for (const height of [80, 180, 300, 420, 700]) {
      for (const offset of [-80, 0, 20, height / 2, height - 44, height + 80]) {
        const frame = resolveWorkspacePickerFrame(
          { ...anchor, y: host.y + offset }, { ...host, height }, 4,
        );
        const top = frame.top ?? height - frame.bottom! - frame.maxHeight;
        expect(top).toBeGreaterThanOrEqual(4);
        expect(top + frame.maxHeight).toBeLessThanOrEqual(height - 4);
        expect(frame.maxHeight).toBeGreaterThanOrEqual(72);
      }
    }
  });
});
