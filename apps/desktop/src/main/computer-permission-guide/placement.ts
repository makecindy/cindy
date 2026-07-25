/** BrowserWindow bounds shape used by the permission-guide placement helper. */
export interface PermissionGuideRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExternalWindowSnapshot {
  app_name?: unknown;
  title?: unknown;
  is_on_screen?: unknown;
  layer?: unknown;
  bounds?: unknown;
  process?: unknown;
}

export const PERMISSION_GUIDE_WINDOW_WIDTH = 480;
export const PERMISSION_GUIDE_WINDOW_HEIGHT = 272;

// The visible card lives inside a larger transparent BrowserWindow. The extra
// space above the card is intentional: the animated cursor can travel outside
// the card without being clipped by the native window bounds.
const CARD_RIGHT_INSET = 16;
const CARD_TOP_INSET = 48;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function rectangleFromUnknown(value: unknown): PermissionGuideRectangle | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.x !== 'number'
    || typeof candidate.y !== 'number'
    || typeof candidate.width !== 'number'
    || typeof candidate.height !== 'number'
    || candidate.width <= 0
    || candidate.height <= 0
  ) {
    return null;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isSystemSettingsWindow(window: ExternalWindowSnapshot): boolean {
  const process = window.process && typeof window.process === 'object'
    ? window.process as Record<string, unknown>
    : null;
  const identityText = [
    stringValue(window.app_name),
    stringValue(window.title),
    stringValue(process?.name),
    stringValue(process?.command),
    stringValue(process?.executable),
  ].join('\n').toLowerCase();
  return (
    identityText.includes('system settings')
    || identityText.includes('系统设置')
    || identityText.includes('システム設定')
    || identityText.includes('시스템 설정')
    || identityText.includes('/system settings.app/')
  );
}

/**
 * Select the real, visible System Settings window from cua-driver's window
 * snapshot. Empty helper windows and menu-bar surfaces are ignored.
 */
export function findSystemSettingsWindowBounds(result: unknown): PermissionGuideRectangle | null {
  if (!result || typeof result !== 'object') return null;
  const windows = (result as { windows?: unknown }).windows;
  if (!Array.isArray(windows)) return null;

  const candidates = windows
    .filter((item): item is ExternalWindowSnapshot => Boolean(item && typeof item === 'object'))
    .filter(isSystemSettingsWindow)
    .filter((item) => item.is_on_screen !== false && item.layer !== 25)
    .map((item) => ({
      bounds: rectangleFromUnknown(item.bounds),
      hasTitle: stringValue(item.title).trim().length > 0,
    }))
    .filter((item): item is { bounds: PermissionGuideRectangle; hasTitle: boolean } => (
      item.bounds !== null && item.bounds.width >= 360 && item.bounds.height >= 280
    ))
    .sort((a, b) => (
      Number(b.hasTitle) - Number(a.hasTitle)
      || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height
    ));

  return candidates[0]?.bounds ?? null;
}

/**
 * Center the visible guide card vertically on the System Settings window, with
 * the card's right edge aligned to the system window. The transparent native
 * window remains clamped to the current display work area.
 */
export function computeComputerPermissionGuideBounds(
  systemWindow: PermissionGuideRectangle,
  workArea: PermissionGuideRectangle,
): PermissionGuideRectangle {
  const width = Math.min(PERMISSION_GUIDE_WINDOW_WIDTH, workArea.width);
  const height = Math.min(PERMISSION_GUIDE_WINDOW_HEIGHT, workArea.height);
  const rightInset = Math.min(CARD_RIGHT_INSET, Math.max(0, width / 8));
  const topInset = Math.min(CARD_TOP_INSET, Math.max(0, height / 5));

  const targetX = systemWindow.x + systemWindow.width - (width - rightInset);
  const visibleCardHeight = height - topInset;
  const centerY = systemWindow.y + systemWindow.height / 2;
  const targetY = centerY - visibleCardHeight / 2 - topInset;

  return {
    x: clamp(targetX, workArea.x, workArea.x + workArea.width - width),
    y: clamp(targetY, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}
