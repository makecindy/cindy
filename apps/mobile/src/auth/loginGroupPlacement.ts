import { keyboardControlRegion, type LayoutRect, type WindowGeometry } from '../platform/windowGeometry';
import { LOGIN_GROUP, resolveLoginSurface, type LoginSurfaceLayout } from './loginSkinLayout';

/** The brand and form share the usable column beside a vertical system bar. */
export function resolveLoginWindowSurface(window: WindowGeometry): LoginSurfaceLayout {
  if (window.width > window.height && (window.width < 760 || window.height < 480)) {
    const stage = resolveLoginSurface(Math.max(1, window.width - window.insets.left - window.insets.right),
      Math.max(1, window.height - window.insets.top - window.insets.bottom));
    return { ...stage, viewportWidth: window.width, viewportHeight: window.height,
      offsetX: stage.offsetX + window.insets.left, offsetY: stage.offsetY + window.insets.top };
  }
  if (window.barEdge === 'none') return resolveLoginSurface(window.width, window.height);
  const width = Math.max(1, window.width - window.insets.left - window.insets.right);
  const stage = resolveLoginSurface(width, window.height);
  return { ...stage, viewportWidth: window.width, offsetX: stage.offsetX + window.insets.left };
}

/** Reserve camera space only when the visible form actually occupies it. */
export function resolveLoginGroupPlacement(
  window: WindowGeometry,
  stage: LoginSurfaceLayout,
  flowHeight: number,
  keyboardBottom: number,
): LayoutRect & { scale: number } {
  const fit = (region: LayoutRect) => {
    const scale = Math.min(stage.scale * stage.loginGroupScale, region.width / LOGIN_GROUP.width);
    const width = LOGIN_GROUP.width * scale;
    const height = Math.min(flowHeight * scale, region.height);
    return {
      x: Math.max(region.x, Math.min(stage.offsetX + stage.loginX * stage.scale, region.x + region.width - width)),
      y: Math.max(region.y, Math.min(stage.offsetY + stage.loginY * stage.scale, region.y + region.height - height)),
      width, height, scale,
    };
  };
  const preferred = fit(keyboardControlRegion({ ...window,
    regions: window.regions.filter(r => r.kind === 'division'),
  }, keyboardBottom));
  const overlapsCamera = window.regions.some(r => r.kind === 'occlusion'
    && r.width > 0 && r.height > 0
    && r.x < preferred.x + preferred.width && r.x + r.width > preferred.x
    && r.y < preferred.y + preferred.height && r.y + r.height > preferred.y);
  return overlapsCamera ? fit(keyboardControlRegion(window, keyboardBottom)) : preferred;
}
