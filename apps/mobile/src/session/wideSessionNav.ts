/** Quick-switch panel sizing. Back navigation remains available at every width. */
const DRAWER_MIN_WIDTH = 300;
/** At least a regular phone's portrait list (iPhone 393–440 pt), so the floating
 * drawer never shows less of the list than the phone does. */
const DRAWER_DEFAULT_WIDTH = 400;
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
  const max = Math.max(DRAWER_MIN_WIDTH, windowWidth - reserve);
  const resizeBounds = { min: DRAWER_MIN_WIDTH, max };
  const preferred = input.preferredWidth;
  const requested = typeof preferred === 'number' && Number.isFinite(preferred) ? preferred : DRAWER_DEFAULT_WIDTH;
  return { drawerWidth: Math.round(clamp(requested, resizeBounds.min, resizeBounds.max)), enabled, resizeBounds };
}

function normalizeDimension(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
