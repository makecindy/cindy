import { describe, expect, it } from 'vitest';

import {
  WORKLOUDER_CODEX_ENCODER_DETENT_DEG,
  WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
  workLouderCodexStickPreviewOffset,
} from '../workLouderCodex';

describe('workLouderCodexStickPreviewOffset', () => {
  it('follows the hardware circle: 0 right, 0.25 down, 0.5 left, 0.75 up', () => {
    expect(workLouderCodexStickPreviewOffset(0, 1)).toEqual({
      x: WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
      y: 0,
    });
    expect(workLouderCodexStickPreviewOffset(0.25, 1).x).toBeCloseTo(0, 8);
    expect(workLouderCodexStickPreviewOffset(0.25, 1).y).toBeCloseTo(
      WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
      8,
    );
    expect(workLouderCodexStickPreviewOffset(0.5, 1).x).toBeCloseTo(
      -WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
      8,
    );
    expect(workLouderCodexStickPreviewOffset(0.5, 1).y).toBeCloseTo(0, 8);
    expect(workLouderCodexStickPreviewOffset(0.75, 1).x).toBeCloseTo(0, 8);
    expect(workLouderCodexStickPreviewOffset(0.75, 1).y).toBeCloseTo(
      -WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
      8,
    );
  });

  it('scales with how far the stick is pushed', () => {
    expect(workLouderCodexStickPreviewOffset(0, 0.5)).toEqual({
      x: WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX / 2,
      y: 0,
    });
    expect(workLouderCodexStickPreviewOffset(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('treats a detent as a fixed encoder step', () => {
    expect(WORKLOUDER_CODEX_ENCODER_DETENT_DEG).toBe(18);
  });
});
