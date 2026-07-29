import type { Point, Rectangle } from 'electron';

/**
 * 语音输入全局浮窗的几何计算纯函数集合。
 *
 * 浮窗拖动 / 位置记忆 / 中线吸附的所有确定性规则都集中在这里，
 * 不依赖 Electron 运行时（只用它的类型），方便在 vitest 里直接
 * 用假 display 数据覆盖多屏、clamp、吸附等分支。IPC handler
 * （global.ts）只做适配：读 cursor / display 快照后调这里的函数。
 */

/** 只保留几何计算需要的 display 字段，避免测试构造完整 Electron Display。 */
export type OverlayPlacementDisplay = {
  id: number;
  workArea: Rectangle;
};

type ClampInput = {
  /** 浮窗 BrowserWindow 的候选 bounds（含透明阴影 padding）。 */
  bounds: Rectangle;
  workArea: Rectangle;
  /** 窗口边缘到可见卡片边缘的透明阴影宽度（对称）。 */
  contentInset: number;
  /** 可见卡片与 workArea 边缘之间保留的最小边距。 */
  edgePadding: number;
};

export type ResolveDraggedOverlayBoundsInput = {
  /** 拖动开始时窗口的 bounds。 */
  startBounds: Rectangle;
  /** 拖动开始时的鼠标屏幕坐标。 */
  startCursor: Point;
  /** 当前鼠标屏幕坐标。 */
  cursor: Point;
  displays: OverlayPlacementDisplay[];
  contentInset: number;
  edgePadding: number;
  /** 卡片中心距 workArea 水平中线小于该值时吸附到水平居中。 */
  snapThresholdX: number;
};

export type SavedOverlayPosition = {
  x: number;
  y: number;
  displayId?: number;
  /**
   * 卡片中心在保存时那块屏 workArea 里的相对比例（0~1）。
   *
   * 绝对坐标一旦遇到显示器重新排布就会失效（同一块屏的 workArea 原点变了），
   * 光靠 x/y 无法还原「用户当时把它放在这块屏的哪个位置」。比例与屏幕排布无关，
   * 是跨屏迁移与重排后恢复的权威依据；x/y 只用于同屏且坐标仍然有效时的像素级
   * 原样恢复。旧快照没有这两个字段，按 x/y 反推。
   */
  ratioX?: number;
  ratioY?: number;
  updatedAt: number;
};

function normalizeRatio(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const ratio = value as number;
  if (ratio < 0 || ratio > 1) return undefined;
  return ratio;
}

/** 校验持久化快照，字段缺失 / 非有限数一律视为无保存位置。 */
export function normalizeSavedOverlayPosition(value: unknown): SavedOverlayPosition | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SavedOverlayPosition>;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    displayId: Number.isFinite(candidate.displayId) ? (candidate.displayId as number) : undefined,
    ratioX: normalizeRatio(candidate.ratioX),
    ratioY: normalizeRatio(candidate.ratioY),
    updatedAt: Number.isFinite(candidate.updatedAt) ? (candidate.updatedAt as number) : 0,
  };
}

/** 落盘前算出屏内相对比例，让记忆不依赖屏幕排布。 */
export function computeOverlayPositionRatio(
  bounds: Rectangle,
  workArea: Rectangle,
): { ratioX: number; ratioY: number } {
  const center = boundsCenter(bounds);
  return {
    ratioX: clampRatio(workArea.width > 0 ? (center.x - workArea.x) / workArea.width : 0.5),
    ratioY: clampRatio(workArea.height > 0 ? (center.y - workArea.y) / workArea.height : 0.5),
  };
}

export type ResolveOverlayInitialBoundsInput = {
  savedPosition: SavedOverlayPosition | null;
  displays: OverlayPlacementDisplay[];
  /**
   * 用户焦点所在的屏（前台窗口所在屏优先，取不到时是鼠标所在屏）。
   * 浮窗必须开在这块屏上，保存位置只决定「在这块屏的什么位置」。
   * null = 调用方拿不到任何屏快照（防御分支）。
   */
  activeDisplay: OverlayPlacementDisplay | null;
  size: { width: number; height: number };
  contentInset: number;
  edgePadding: number;
  /** 无保存位置或保存位置不可用时的默认 bounds（焦点屏上的 computeOverlayBounds 结果）。 */
  fallbackBounds: Rectangle;
};

function rectContainsPoint(rect: Rectangle, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function findDisplayContainingPoint(
  displays: OverlayPlacementDisplay[],
  point: Point,
): OverlayPlacementDisplay | null {
  return displays.find((display) => rectContainsPoint(display.workArea, point)) ?? null;
}

function findNearestDisplay(
  displays: OverlayPlacementDisplay[],
  point: Point,
): OverlayPlacementDisplay | null {
  let nearest: OverlayPlacementDisplay | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { workArea } = display;
    // 点到矩形的最近距离（矩形内为 0）。
    const dx = Math.max(workArea.x - point.x, 0, point.x - (workArea.x + workArea.width));
    const dy = Math.max(workArea.y - point.y, 0, point.y - (workArea.y + workArea.height));
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = display;
    }
  }
  return nearest;
}

function boundsCenter(bounds: Rectangle): Point {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function clampRatio(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** 卡片中心是否还落在某块现存屏幕的 workArea 里（判断缓存锚点是否仍然可见）。 */
export function isBoundsCenterOnDisplay(
  bounds: Rectangle,
  displays: OverlayPlacementDisplay[],
): boolean {
  return findDisplayContainingPoint(displays, boundsCenter(bounds)) !== null;
}

/**
 * 把窗口 bounds clamp 进 workArea，保证「可见卡片」（窗口 rect 向内收
 * contentInset）与 workArea 边缘至少保留 edgePadding。窗口本身的透明
 * 阴影区允许探出屏幕外。workArea 小到放不下时退化为居中。
 */
export function clampOverlayBoundsToWorkArea({
  bounds,
  workArea,
  contentInset,
  edgePadding,
}: ClampInput): Rectangle {
  const margin = edgePadding - contentInset;
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - bounds.width - margin;
  const minY = workArea.y + margin;
  const maxY = workArea.y + workArea.height - bounds.height - margin;
  const x = maxX < minX
    ? workArea.x + Math.round((workArea.width - bounds.width) / 2)
    : Math.min(Math.max(bounds.x, minX), maxX);
  const y = maxY < minY
    ? workArea.y + Math.round((workArea.height - bounds.height) / 2)
    : Math.min(Math.max(bounds.y, minY), maxY);
  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
}

/**
 * 拖动中的位置解析：pointer delta → 候选位置 → 找目标屏 → clamp →
 * X 轴中线吸附（灵动岛式）。全程无状态，每个 move tick 从拖动起点
 * 重新计算，吸附后继续拖离中线即自然解除。
 */
export function resolveDraggedOverlayBounds({
  startBounds,
  startCursor,
  cursor,
  displays,
  contentInset,
  edgePadding,
  snapThresholdX,
}: ResolveDraggedOverlayBoundsInput): Rectangle {
  const candidate: Rectangle = {
    x: startBounds.x + (cursor.x - startCursor.x),
    y: startBounds.y + (cursor.y - startCursor.y),
    width: startBounds.width,
    height: startBounds.height,
  };
  if (displays.length === 0) return candidate;
  const center = boundsCenter(candidate);
  const display = findDisplayContainingPoint(displays, center)
    ?? findNearestDisplay(displays, center);
  if (!display) return candidate;

  const clamped = clampOverlayBoundsToWorkArea({
    bounds: candidate,
    workArea: display.workArea,
    contentInset,
    edgePadding,
  });

  // 阴影 padding 对称，窗口中心即卡片中心。
  const cardCenterX = clamped.x + clamped.width / 2;
  const workAreaCenterX = display.workArea.x + display.workArea.width / 2;
  if (Math.abs(cardCenterX - workAreaCenterX) <= snapThresholdX) {
    return clampOverlayBoundsToWorkArea({
      bounds: { ...clamped, x: Math.round(workAreaCenterX - clamped.width / 2) },
      workArea: display.workArea,
      contentInset,
      edgePadding,
    });
  }
  return clamped;
}

/** 把「屏内相对比例」还原成某块屏上的窗口 bounds。 */
function boundsFromRatio(
  ratio: { ratioX: number; ratioY: number },
  workArea: Rectangle,
  size: { width: number; height: number },
): Rectangle {
  return {
    x: Math.round(workArea.x + workArea.width * ratio.ratioX - size.width / 2),
    y: Math.round(workArea.y + workArea.height * ratio.ratioY - size.height / 2),
    width: size.width,
    height: size.height,
  };
}

/**
 * 打开浮窗时的初始位置。
 *
 * 「浮窗开在焦点屏」是硬约束，位置记忆只在焦点屏内部生效：
 * - 无保存位置 / 记忆所属屏已不存在（典型：外接屏已拔掉）→ 焦点屏默认位置。
 * - 快照带屏内相对比例 → 一律按比例还原到焦点屏。workArea 没变时它还原出的就是
 *   原坐标（±1px 取整），变了（分辨率 / 缩放 / 排布调整）则跟着新尺寸走，不会
 *   把「原来居中」变成「偏左」。
 * - 旧快照没有比例 → 坐标仍落在归属屏内时：同屏按绝对坐标原样恢复，跨屏按坐标
 *   反推的比例迁移；坐标已经不在归属屏内（升级前的坐标 + 之后的显示器重排）则
 *   无从还原原意，回退默认位置，不去夹出一个贴边的假位置。
 *
 * 记忆所属屏认 `displayId`：显示器重排后旧坐标可能正好落进另一块屏，那是坐标
 * 失效而不是「用户当时放在那块屏」。`displayId` 记着但已不在 = 那块屏被拔掉，
 * 直接回退默认位置；只有完全没有 `displayId` 的旧快照才从坐标反推归属屏。
 */
export function resolveOverlayInitialBounds({
  savedPosition,
  displays,
  activeDisplay,
  size,
  contentInset,
  edgePadding,
  fallbackBounds,
}: ResolveOverlayInitialBoundsInput): Rectangle {
  if (!savedPosition || displays.length === 0) return fallbackBounds;
  if (!Number.isFinite(savedPosition.x) || !Number.isFinite(savedPosition.y)) return fallbackBounds;
  const saved: Rectangle = {
    x: Math.round(savedPosition.x),
    y: Math.round(savedPosition.y),
    width: size.width,
    height: size.height,
  };
  const savedDisplay = savedPosition.displayId !== undefined
    ? displays.find((display) => display.id === savedPosition.displayId) ?? null
    : findDisplayContainingPoint(displays, boundsCenter(saved));
  if (!savedDisplay) return fallbackBounds;
  const targetDisplay = activeDisplay ?? savedDisplay;
  const savedRatio = savedPosition.ratioX !== undefined && savedPosition.ratioY !== undefined
    ? { ratioX: savedPosition.ratioX, ratioY: savedPosition.ratioY }
    : null;
  const savedCoordsUsable = rectContainsPoint(savedDisplay.workArea, boundsCenter(saved));
  if (!savedRatio) {
    // 旧快照没有比例，只能从绝对坐标反推。坐标已经不在归属屏内时（典型：升级前
    // 存的坐标 + 之后显示器重排改了这块屏的 workArea 原点）反推不出有意义的比例
    // ——夹到 0~1 会把「原本居中」恢复成贴边，不如老老实实回退默认位置。
    if (!savedCoordsUsable) return fallbackBounds;
    if (targetDisplay.id === savedDisplay.id) {
      return clampOverlayBoundsToWorkArea({
        bounds: saved,
        workArea: targetDisplay.workArea,
        contentInset,
        edgePadding,
      });
    }
  }
  const bounds = boundsFromRatio(
    savedRatio ?? computeOverlayPositionRatio(saved, savedDisplay.workArea),
    targetDisplay.workArea,
    size,
  );
  return clampOverlayBoundsToWorkArea({
    bounds,
    workArea: targetDisplay.workArea,
    contentInset,
    edgePadding,
  });
}

/**
 * 校验 macOS helper 返回的前台窗口 frame。宽高必须为正：AX 偶尔会给出
 * 0 尺寸的占位窗口，那种 frame 不能用来判断焦点屏。
 */
export function normalizeFocusedWindowFrame(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Rectangle>;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return null;
  if ((candidate.width as number) <= 0 || (candidate.height as number) <= 0) return null;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
  };
}
