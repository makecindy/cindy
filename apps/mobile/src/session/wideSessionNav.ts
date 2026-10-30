/** Quick-switch panel sizing. Back navigation remains available at every width. */
const DRAWER_MIN_WIDTH = 300;
const DRAWER_MAX_WIDTH = 360;
const DRAWER_WIDTH_RATIO = 0.4;

export interface WideSessionNavLayoutInput {
  windowWidth?: number;
  windowHeight?: number;
  /** Retained for existing callers; sizing is platform-independent. */
  platform?: string;
  /** Retained for existing callers; phone and tablet share this behavior. */
  iosPad?: boolean;
}

export interface WideSessionNavLayout {
  /** Whether a measured window can host quick switching. */
  enabled: boolean;
  /** 抽屉面板宽度(enabled 为 false 时给 0,调用方不消费)。 */
  drawerWidth: number;
}

export function buildWideSessionNavLayout(
  input: WideSessionNavLayoutInput,
): WideSessionNavLayout {
  const windowWidth = normalizeDimension(input.windowWidth);
  const enabled = windowWidth >= 600;
  if (!enabled) return { drawerWidth: 0, enabled };
  const drawerWidth = Math.min(
    Math.max(0, windowWidth - 24),
    clamp(Math.round(windowWidth * DRAWER_WIDTH_RATIO), DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH),
  );
  return { drawerWidth, enabled };
}

function normalizeDimension(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
