import { describe, expect, it } from 'vitest';

import {
  WORKLOUDER_CODEX_ENCODER_DETENT_DEG,
  WORKLOUDER_CODEX_STICK_PREVIEW_TRAVEL_PX,
  WORKLOUDER_CODEX_TASK_TITLE_MAX_LENGTH,
  capWorkLouderTaskTitle,
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

// #9403：设备按 512 字符收任务标题，超长标题会让整份任务列表被主进程拒收。
// 截断必须与主进程校验同口径（UTF-16），否则截完还是会被拒。
describe('capWorkLouderTaskTitle', () => {
  it('keeps short titles and caps long ones at the device limit', () => {
    expect(capWorkLouderTaskTitle('Fix #1234')).toBe('Fix #1234');
    const long = 'a'.repeat(WORKLOUDER_CODEX_TASK_TITLE_MAX_LENGTH + 40);
    expect(capWorkLouderTaskTitle(long)).toBe(
      'a'.repeat(WORKLOUDER_CODEX_TASK_TITLE_MAX_LENGTH),
    );
  });

  it('drops a half surrogate pair left at the cut so the device shows no broken glyph', () => {
    const title = `${'a'.repeat(511)}😀`; // 511 ASCII + 一个 emoji（2 个 code unit）
    expect(title.length).toBe(513);
    expect(capWorkLouderTaskTitle(title)).toBe('a'.repeat(511));
  });

  it('keeps an emoji that fits entirely', () => {
    const title = `${'a'.repeat(510)}😀`;
    expect(title.length).toBe(WORKLOUDER_CODEX_TASK_TITLE_MAX_LENGTH);
    expect(capWorkLouderTaskTitle(title)).toBe(title);
  });
});
