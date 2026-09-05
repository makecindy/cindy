export interface RewindPreviewLayoutInput {
  fileCount: number;
  screenWidth: number;
}

export interface RewindPreviewLayout {
  compact: boolean;
  containerMarginHorizontal: number;
  containerPadding: number;
  fileRowMinHeight: number;
  visibleFileCount: number;
}

export interface RewindPreviewViewportInput {
  screenHeight: number;
  topOverlayHeight?: number;
  bottomOverlayHeight?: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const DEFAULT_SCREEN_HEIGHT = 844;
const COMPACT_WIDTH = 360;
const STANDARD_SPACE = 16;
const COMPACT_SPACE = 12;
const STANDARD_VISIBLE_FILES = 6;
const COMPACT_VISIBLE_FILES = 4;
const PANEL_EDGE_GAP = 8;

/** 回退预览面板布局:compact 只由屏宽决定(操作区已收敛到 MainWindowActionGroup,不再输出按钮尺寸)。 */
export function buildRewindPreviewLayout(input: RewindPreviewLayoutInput): RewindPreviewLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const fileCount = normalizeCount(input.fileCount);
  const compact = screenWidth <= COMPACT_WIDTH;
  const visibleLimit = compact ? COMPACT_VISIBLE_FILES : STANDARD_VISIBLE_FILES;

  return {
    compact,
    containerMarginHorizontal: compact ? COMPACT_SPACE : STANDARD_SPACE,
    containerPadding: compact ? COMPACT_SPACE : STANDARD_SPACE,
    fileRowMinHeight: compact ? 30 : 32,
    visibleFileCount: Math.min(fileCount, visibleLimit),
  };
}

/** Keeps the rewind panel inside the space between the fixed top and bottom overlays. */
export function rewindPreviewMaxHeight(input: RewindPreviewViewportInput): number {
  const screenHeight = normalizeDimension(input.screenHeight, DEFAULT_SCREEN_HEIGHT);
  const topOverlayHeight = normalizeInset(input.topOverlayHeight);
  const bottomOverlayHeight = normalizeInset(input.bottomOverlayHeight);
  return Math.max(0, screenHeight - topOverlayHeight - bottomOverlayHeight - PANEL_EDGE_GAP * 2);
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeInset(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
