import { taskListResizeBounds, taskListWidth } from './taskListWidth';

/** Leave enough scrim beside the drawer to see the task and tap to close. */
const DRAWER_MIN_SCRIM = 96;

export interface WideSessionNavLayoutInput {
  windowWidth?: number;
  windowHeight?: number;
  /** The shared task-list width the user dragged; null until then. */
  preferredWidth?: number | null;
  /** Width kept clear at the top trailing corner (Duo's status area), so the
   * drawer's header buttons never settle under it. */
  trailingReserve?: number;
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
  /** Drag range of the drawer's edge; null when disabled. */
  resizeBounds: { min: number; max: number } | null;
}

export function buildWideSessionNavLayout(
  input: WideSessionNavLayoutInput,
): WideSessionNavLayout {
  const windowWidth = normalizeDimension(input.windowWidth);
  const enabled = windowWidth >= 600;
  if (!enabled) return { drawerWidth: 0, enabled, resizeBounds: null };
  const reserve = Math.max(DRAWER_MIN_SCRIM, normalizeDimension(input.trailingReserve));
  const resizeBounds = taskListResizeBounds(windowWidth - reserve);
  return { drawerWidth: taskListWidth(input.preferredWidth, resizeBounds), enabled, resizeBounds };
}

function normalizeDimension(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}
