// 测试价值：远程设备画面上的触控板真实双指必须与本机一致——两指落在光标两侧、按触控板物理比例
// 与画面长边等比移动（捏合比例与角度不变形）、到画面边缘即停且不累计越界位移。算法与 Main 为插件页
// 做的映射（main/nativeTrackpad.ts）是两份实现，漂移就会出现「同一手势在本机与远程效果不同」。
// 最小输入：一组双指采样；unit tier。
import { expect, it } from 'vitest';
import { createTrackpadContactMapper } from '../trackpadContacts';

const rect = { x: 100, y: 50, width: 300, height: 600 };
const pointer = { x: 250, y: 350 };
const frame = (
  phase: 'begin' | 'change' | 'end' | 'cancel',
  touches: [number, number, number][],
) => ({
  phase,
  width: 160,
  height: 100,
  touches: touches.map(([id, x, y]) => ({ id, x, y })),
});
const at = (result: ReturnType<ReturnType<typeof createTrackpadContactMapper>['map']>) =>
  result?.touches.map((t) => [t.id, +t.x.toFixed(3), +t.y.toFixed(3)]);

it('lands the two fingers around the cursor and moves them like the real ones', () => {
  const mapper = createTrackpadContactMapper();
  // A sequence must begin over the picture.
  expect(
    mapper.map(
      frame('begin', [
        [0, 0.4, 0.5],
        [1, 0.6, 0.5],
      ]),
      rect,
      { x: 10, y: 10 },
    ),
  ).toBeNull();
  expect(
    mapper.map(
      frame('change', [
        [0, 0.4, 0.5],
        [1, 0.6, 0.5],
      ]),
      rect,
      pointer,
    ),
  ).toBeNull();
  // 0.2 of the trackpad apart → 0.2 × the long edge (600) = 120 px, centred on the cursor.
  expect(
    at(
      mapper.map(
        frame('begin', [
          [0, 0.4, 0.5],
          [1, 0.6, 0.5],
        ]),
        rect,
        pointer,
      ),
    ),
  ).toEqual([
    [0, 0.3, 0.5],
    [1, 0.7, 0.5],
  ]);
  // The vertical axis follows the trackpad's physical proportions (100 / 160).
  expect(
    at(
      mapper.map(
        frame('change', [
          [0, 0.4, 0.7],
          [1, 0.6, 0.5],
        ]),
        rect,
        pointer,
      ),
    ),
  ).toEqual([
    [0, 0.3, 0.625],
    [1, 0.7, 0.5],
  ]);
  // A finger stops at the edge; coming back moves it at once, with no overshoot to repay.
  expect(
    at(
      mapper.map(
        frame('change', [
          [0, 0, 0.7],
          [1, 0.6, 0.5],
        ]),
        rect,
        pointer,
      ),
    )?.[0],
  ).toEqual([0, 0.002, 0.625]);
  expect(
    at(
      mapper.map(
        frame('change', [
          [0, 0.05, 0.7],
          [1, 0.6, 0.5],
        ]),
        rect,
        pointer,
      ),
    )?.[0],
  ).toEqual([0, 0.102, 0.625]);
  // One finger lifts, then the other; afterwards nothing is tracked.
  expect(at(mapper.map(frame('change', [[1, 0.6, 0.5]]), rect, pointer))).toEqual([[1, 0.7, 0.5]]);
  expect(mapper.map(frame('end', []), rect, pointer)).toEqual({ phase: 'end', touches: [] });
  expect(mapper.map(frame('cancel', []), rect, pointer)).toBeNull();
});
