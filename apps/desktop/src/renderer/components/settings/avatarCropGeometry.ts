/**
 * avatarCropGeometry — 头像取景的纯几何(无 DOM、无副作用,可直接单测)。
 *
 * 唯一的状态是**源图像素坐标系**里的一块正方形 `AvatarCrop`(中心 + 边长)。
 * 编辑台画布、确认后的小预览和最终导出都从这同一块矩形推导:编辑台用
 * `avatarStageTransform` 把整张图按它摆放,导出用 `avatarCropDrawRect` 把它
 * 原样画进输出画布——两条路径共享同一组数,所以「看到的圈内」与「上传的像素」
 * 不可能各算各的、出现二次裁剪或拉伸。
 *
 * 不变量(`clampAvatarCrop` 保证):
 *   - 正方形完整落在源图内 → 平移 / 缩放都不会露出图外空白,导出不含透明边;
 *   - 边长 ∈ [短边 / 最大倍率, 短边] → zoom 1 = 恰好铺满(cover),不允许缩到露底。
 */

/** 已按 EXIF 方向转正后的源图尺寸(px)。 */
export interface AvatarImageSize {
  width: number;
  height: number;
}

/** 源图坐标系里的正方形取景:中心点与边长(px,可为小数)。 */
export interface AvatarCrop {
  cx: number;
  cy: number;
  side: number;
}

/** 相对取景圆心的视图坐标(CSS px),用于以光标 / 双指中点为焦点缩放。 */
export interface AvatarViewPoint {
  x: number;
  y: number;
}

/** 最大放大倍率(相对铺满)。4x 时 4000px 照片的取景仍有 ~750px,高于输出边长。 */
export const AVATAR_CROP_MAX_ZOOM = 4;
/** 按钮 / 快捷键每步缩放倍率,与图片 lightbox 的步进一致。 */
export const AVATAR_CROP_ZOOM_STEP = 1.2;
/** 导出边长上限:足够 Retina 下的大头像展示,又远低于服务端 5MB 上限。 */
export const AVATAR_OUTPUT_MAX_PX = 512;
/** 导出边长下限:极小的源图也放大到可用清晰度,避免上传 20px 头像。 */
export const AVATAR_OUTPUT_MIN_PX = 128;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function shortSide(size: AvatarImageSize) {
  return Math.min(size.width, size.height);
}

/** 当前放大倍率:1 = 铺满,`AVATAR_CROP_MAX_ZOOM` = 最大。 */
export function avatarCropZoom(crop: AvatarCrop, size: AvatarImageSize) {
  return shortSide(size) / crop.side;
}

/** 把取景收回合法范围(见文件头不变量)。 */
export function clampAvatarCrop(crop: AvatarCrop, size: AvatarImageSize): AvatarCrop {
  const min = shortSide(size);
  const side = clamp(crop.side, min / AVATAR_CROP_MAX_ZOOM, min);
  const half = side / 2;
  return {
    side,
    cx: clamp(crop.cx, half, size.width - half),
    cy: clamp(crop.cy, half, size.height - half),
  };
}

/**
 * 初始构图:铺满并居中。横图左右留出可平移余量,竖图上下留出,方图正好填满。
 * 不做「人脸偏上」之类的猜测——可预测比偶尔猜中更重要,用户一拖即可修正。
 */
export function initialAvatarCrop(size: AvatarImageSize): AvatarCrop {
  return { cx: size.width / 2, cy: size.height / 2, side: shortSide(size) };
}

/**
 * 跟手平移:视图里拖动 (dx, dy) 个 CSS px,图片跟着手走同样的视觉距离。
 * `viewSide` 是取景圆在屏幕上的直径。越界部分被夹住(手继续走、图停在边上)。
 */
export function panAvatarCrop(
  crop: AvatarCrop,
  size: AvatarImageSize,
  dx: number,
  dy: number,
  viewSide: number,
): AvatarCrop {
  if (!(viewSide > 0)) return crop; // stage 尚未量出尺寸
  const scale = viewSide / crop.side;
  return clampAvatarCrop({ ...crop, cx: crop.cx - dx / scale, cy: crop.cy - dy / scale }, size);
}

/**
 * 缩放到 `zoom`(会被夹到 [1, 最大倍率]),并保持 `focal` 下方的那个源图点在屏幕上不动;
 * 不给 focal 时以取景圆心为焦点(滑杆 / 按钮 / 键盘)。缩小时若焦点附近已贴边,
 * clamp 会把中心推回图内——这是「不露空白」优先于「焦点绝对不动」的有意取舍。
 */
export function zoomAvatarCrop(
  crop: AvatarCrop,
  size: AvatarImageSize,
  zoom: number,
  viewSide: number,
  focal: AvatarViewPoint = { x: 0, y: 0 },
): AvatarCrop {
  if (!(viewSide > 0)) return crop; // stage 尚未量出尺寸
  const nextZoom = clamp(zoom, 1, AVATAR_CROP_MAX_ZOOM);
  const scale = viewSide / crop.side;
  const sourceX = crop.cx + focal.x / scale;
  const sourceY = crop.cy + focal.y / scale;
  const side = shortSide(size) / nextZoom;
  const nextScale = viewSide / side;
  return clampAvatarCrop(
    { side, cx: sourceX - focal.x / nextScale, cy: sourceY - focal.y / nextScale },
    size,
  );
}

/**
 * 编辑台画布上整张源图的摆放:先按 `scale` 缩放,再把左上角放到 (x, y)(stage CSS px)。
 * 取景圆固定在 stage 正中,直径 `viewSide`。
 */
export function avatarStageTransform(
  crop: AvatarCrop,
  viewSide: number,
  stageWidth: number,
  stageHeight: number,
) {
  const scale = viewSide / crop.side;
  return {
    scale,
    x: stageWidth / 2 - crop.cx * scale,
    y: stageHeight / 2 - crop.cy * scale,
  };
}

/** 导出边长:按取景实际覆盖的源像素取整,夹在 [下限, 上限],不做无意义的放大。 */
export function avatarOutputSize(crop: AvatarCrop) {
  return clamp(Math.round(crop.side), AVATAR_OUTPUT_MIN_PX, AVATAR_OUTPUT_MAX_PX);
}

/** 导出时 drawImage 的源矩形(源图 px)。编辑台、预览、导出的唯一共享映射。 */
export function avatarCropDrawRect(crop: AvatarCrop) {
  return {
    sx: crop.cx - crop.side / 2,
    sy: crop.cy - crop.side / 2,
    sw: crop.side,
    sh: crop.side,
  };
}

/**
 * 滑杆值 ⇄ 倍率:对数映射,让滑杆每一格带来相同的「视觉放大感」
 * (线性映射会让 1x→1.5x 挤在最左边一小段,手感前紧后松)。
 */
export const AVATAR_ZOOM_SLIDER_MAX = 100;

export function avatarZoomToSlider(zoom: number) {
  const ratio = Math.log(clamp(zoom, 1, AVATAR_CROP_MAX_ZOOM)) / Math.log(AVATAR_CROP_MAX_ZOOM);
  return ratio * AVATAR_ZOOM_SLIDER_MAX;
}

export function avatarSliderToZoom(value: number) {
  const ratio = clamp(value, 0, AVATAR_ZOOM_SLIDER_MAX) / AVATAR_ZOOM_SLIDER_MAX;
  return AVATAR_CROP_MAX_ZOOM ** ratio;
}
