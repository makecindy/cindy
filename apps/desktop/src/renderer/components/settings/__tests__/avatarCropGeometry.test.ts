import { describe, expect, it } from 'vitest';

import {
  AVATAR_CROP_MAX_ZOOM,
  AVATAR_OUTPUT_MAX_PX,
  AVATAR_OUTPUT_MIN_PX,
  AVATAR_ZOOM_SLIDER_MAX,
  avatarCropDrawRect,
  avatarCropZoom,
  avatarOutputSize,
  avatarSliderToZoom,
  avatarStageTransform,
  avatarZoomToSlider,
  clampAvatarCrop,
  initialAvatarCrop,
  panAvatarCrop,
  zoomAvatarCrop,
  type AvatarCrop,
  type AvatarImageSize,
} from '../avatarCropGeometry';

const VIEW = 240;
const LANDSCAPE: AvatarImageSize = { width: 4000, height: 3000 };
const PORTRAIT: AvatarImageSize = { width: 1080, height: 1920 };
const TINY: AvatarImageSize = { width: 48, height: 40 };

/** 取景正方形完整落在图内、边长在合法范围:导出不会采到图外(透明 / 空白)。 */
function expectInside(crop: AvatarCrop, size: AvatarImageSize) {
  const { sx, sy, sw, sh } = avatarCropDrawRect(crop);
  const eps = 1e-9;
  expect(sx).toBeGreaterThanOrEqual(-eps);
  expect(sy).toBeGreaterThanOrEqual(-eps);
  expect(sx + sw).toBeLessThanOrEqual(size.width + eps);
  expect(sy + sh).toBeLessThanOrEqual(size.height + eps);
  expect(sw).toBeCloseTo(sh, 12);
  const zoom = avatarCropZoom(crop, size);
  expect(zoom).toBeGreaterThanOrEqual(1 - eps);
  expect(zoom).toBeLessThanOrEqual(AVATAR_CROP_MAX_ZOOM + eps);
}

/** 视图坐标(相对圆心)下方对应的源图点。 */
function sourceUnder(crop: AvatarCrop, point: { x: number; y: number }) {
  const scale = VIEW / crop.side;
  return { x: crop.cx + point.x / scale, y: crop.cy + point.y / scale };
}

describe('avatarCropGeometry', () => {
  it('初始构图铺满并居中:横图左右留余量、竖图上下留余量、小图同样铺满', () => {
    expect(initialAvatarCrop(LANDSCAPE)).toEqual({ cx: 2000, cy: 1500, side: 3000 });
    expect(initialAvatarCrop(PORTRAIT)).toEqual({ cx: 540, cy: 960, side: 1080 });
    expect(initialAvatarCrop(TINY)).toEqual({ cx: 24, cy: 20, side: 40 });
    for (const size of [LANDSCAPE, PORTRAIT, TINY]) {
      expect(avatarCropZoom(initialAvatarCrop(size), size)).toBe(1);
      expectInside(initialAvatarCrop(size), size);
    }
  });

  it('平移跟手:视图拖动 1px = 图片在屏幕上同向移动 1px', () => {
    const crop = zoomAvatarCrop(initialAvatarCrop(LANDSCAPE), LANDSCAPE, 2, VIEW);
    const before = avatarStageTransform(crop, VIEW, 368, 288);
    const moved = panAvatarCrop(crop, LANDSCAPE, 12, -7, VIEW);
    const after = avatarStageTransform(moved, VIEW, 368, 288);
    expect(after.x - before.x).toBeCloseTo(12, 9);
    expect(after.y - before.y).toBeCloseTo(-7, 9);
  });

  it('平移越界被夹住,永远不露出图外空白', () => {
    let crop = initialAvatarCrop(LANDSCAPE);
    // 横图铺满时只能左右移动:纵向拖动是 no-op。
    expect(panAvatarCrop(crop, LANDSCAPE, 0, 500, VIEW)).toEqual(crop);
    crop = panAvatarCrop(crop, LANDSCAPE, 1e6, 1e6, VIEW);
    expect(crop.cx).toBe(crop.side / 2);
    expectInside(crop, LANDSCAPE);
    crop = panAvatarCrop(crop, LANDSCAPE, -1e6, -1e6, VIEW);
    expect(crop.cx).toBe(LANDSCAPE.width - crop.side / 2);
    expectInside(crop, LANDSCAPE);
  });

  it('以焦点缩放:光标下的源图点在缩放前后保持不动(未触边时)', () => {
    const crop = zoomAvatarCrop(initialAvatarCrop(LANDSCAPE), LANDSCAPE, 1.5, VIEW);
    const focal = { x: 40, y: -30 };
    const before = sourceUnder(crop, focal);
    const zoomed = zoomAvatarCrop(crop, LANDSCAPE, 2.5, VIEW, focal);
    const after = sourceUnder(zoomed, focal);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(avatarCropZoom(zoomed, LANDSCAPE)).toBeCloseTo(2.5, 12);
  });

  it('缩放倍率夹在 [1, 最大倍率];缩小到边界时中心被推回图内', () => {
    const base = initialAvatarCrop(PORTRAIT);
    expect(avatarCropZoom(zoomAvatarCrop(base, PORTRAIT, 0.2, VIEW), PORTRAIT)).toBe(1);
    expect(avatarCropZoom(zoomAvatarCrop(base, PORTRAIT, 99, VIEW), PORTRAIT)).toBeCloseTo(
      AVATAR_CROP_MAX_ZOOM,
      12,
    );
    // 放大后挪到右下角,再以左上焦点缩回 1x:不能露空白。
    let crop = zoomAvatarCrop(base, PORTRAIT, 3, VIEW);
    crop = panAvatarCrop(crop, PORTRAIT, -1e6, -1e6, VIEW);
    crop = zoomAvatarCrop(crop, PORTRAIT, 1, VIEW, { x: -120, y: -120 });
    expectInside(crop, PORTRAIT);
  });

  it('连续缩放无跳变:细步缩放与一步到位结果一致', () => {
    const base = initialAvatarCrop(LANDSCAPE);
    const focal = { x: 10, y: 20 };
    let stepped = base;
    for (let i = 1; i <= 50; i += 1) {
      stepped = zoomAvatarCrop(stepped, LANDSCAPE, 1 + i * 0.02, VIEW, focal);
    }
    const direct = zoomAvatarCrop(base, LANDSCAPE, 2, VIEW, focal);
    expect(stepped.side).toBeCloseTo(direct.side, 9);
    expect(stepped.cx).toBeCloseTo(direct.cx, 6);
    expect(stepped.cy).toBeCloseTo(direct.cy, 6);
  });

  it('stage 尚未量出尺寸(viewSide=0)时平移 / 缩放是 no-op,不产生 NaN', () => {
    const crop = initialAvatarCrop(LANDSCAPE);
    expect(panAvatarCrop(crop, LANDSCAPE, 10, 10, 0)).toBe(crop);
    expect(zoomAvatarCrop(crop, LANDSCAPE, 2, 0)).toBe(crop);
  });

  it('clamp 修正任意非法取景(过大、过小、越界)', () => {
    expectInside(clampAvatarCrop({ cx: -50, cy: 9e9, side: 9e9 }, LANDSCAPE), LANDSCAPE);
    expectInside(clampAvatarCrop({ cx: 0, cy: 0, side: 1 }, TINY), TINY);
  });

  it('编辑台摆放与导出源矩形同源:取景圆在屏幕上恰好覆盖导出区域', () => {
    const crop = panAvatarCrop(
      zoomAvatarCrop(initialAvatarCrop(PORTRAIT), PORTRAIT, 2.2, VIEW, { x: 30, y: 50 }),
      PORTRAIT,
      -15,
      40,
      VIEW,
    );
    const stage = { width: 368, height: 288 };
    const { scale, x, y } = avatarStageTransform(crop, VIEW, stage.width, stage.height);
    const { sx, sy, sw } = avatarCropDrawRect(crop);
    // 导出矩形左上角映射回 stage 上就是取景圆的外接正方形左上角。
    expect(x + sx * scale).toBeCloseTo((stage.width - VIEW) / 2, 9);
    expect(y + sy * scale).toBeCloseTo((stage.height - VIEW) / 2, 9);
    expect(sw * scale).toBeCloseTo(VIEW, 9);
  });

  it('导出边长按取景源像素取整并夹在上下限,不拉伸(始终正方形)', () => {
    expect(avatarOutputSize(initialAvatarCrop(LANDSCAPE))).toBe(AVATAR_OUTPUT_MAX_PX);
    expect(avatarOutputSize(initialAvatarCrop(TINY))).toBe(AVATAR_OUTPUT_MIN_PX);
    expect(avatarOutputSize({ cx: 200, cy: 200, side: 300.4 })).toBe(300);
  });

  it('滑杆对数映射可逆,两端对应 1x 与最大倍率', () => {
    expect(avatarZoomToSlider(1)).toBe(0);
    expect(avatarZoomToSlider(AVATAR_CROP_MAX_ZOOM)).toBeCloseTo(AVATAR_ZOOM_SLIDER_MAX, 12);
    expect(avatarSliderToZoom(0)).toBe(1);
    expect(avatarSliderToZoom(AVATAR_ZOOM_SLIDER_MAX)).toBeCloseTo(AVATAR_CROP_MAX_ZOOM, 12);
    for (const zoom of [1.1, 1.7, 2, 3.3]) {
      expect(avatarSliderToZoom(avatarZoomToSlider(zoom))).toBeCloseTo(zoom, 12);
    }
    // 中点 = 几何平均 2x(4x 上限下),而不是线性的 2.5x。
    expect(avatarSliderToZoom(AVATAR_ZOOM_SLIDER_MAX / 2)).toBeCloseTo(2, 12);
  });
});
