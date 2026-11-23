import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

const BASE_LAYER_Z_INDEX = Z_INDEX_LAYERS.fullscreen;
const FOREGROUND_LAYER_Z_INDEX = Z_INDEX_LAYERS['modal'];

let activationLayerCount = 0;

/** The foreground preview owns both keyboard shortcuts and the highest preview stack. */
function raiseLightboxLayer(foreground: HTMLElement | null): void {
  document.querySelectorAll<HTMLElement>('[data-lightbox-layer]').forEach((layer) => {
    layer.style.zIndex = String(BASE_LAYER_Z_INDEX);
  });
  if (foreground) foreground.style.zIndex = String(FOREGROUND_LAYER_Z_INDEX);
}

/** Activated preview layers own shortcuts until a newer layer is mounted. */
export function activateLightboxLayer(element: HTMLElement | null): void {
  if (!element) return;
  const layers = document.querySelectorAll<HTMLElement>('[data-lightbox-layer]');
  activationLayerCount = layers.length;
  layers.forEach((layer) => {
    if (layer !== element) layer.removeAttribute('data-preview-active');
  });
  element.setAttribute('data-preview-active', '');
  raiseLightboxLayer(element);
}

/** A layer mounted after the last activation supersedes the activated layer. */
function foregroundLayer(): HTMLElement | null {
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-lightbox-layer]'));
  const active = document.querySelector<HTMLElement>('[data-lightbox-layer][data-preview-active]');
  let foreground: HTMLElement | null;
  if (active && layers.length <= activationLayerCount) {
    foreground = active;
  } else {
    foreground = layers.at(-1) ?? null;
    if (foreground && foreground !== active) {
      active?.removeAttribute('data-preview-active');
      foreground.setAttribute('data-preview-active', '');
      activationLayerCount = layers.length;
    }
  }
  raiseLightboxLayer(foreground);
  return foreground;
}

/** Focus and raise the registered preview that owns this attachment ID. */
export function focusPreviewOwner(ownerId: string | null): boolean {
  if (!ownerId) return false;
  const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-lightbox-layer]')).find(
    (layer) => layer.dataset.previewOwnerId === ownerId,
  );
  if (!panel) return false;
  activateLightboxLayer(panel);
  if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  return true;
}

export function isLightboxCovered(element: HTMLElement): boolean {
  const foreground = foregroundLayer();
  return foreground !== null && !foreground.contains(element);
}

/**
 * Active shortcuts belong to the foreground preview only. A non-modal image
 * preview yields to the background conversation when focus is outside its
 * panel; body/documentElement means no explicit focus, so the preview still
 * owns its shortcuts after opening.
 */
export function lightboxOwnsShortcutTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
): boolean {
  if (!panel || isLightboxCovered(panel)) return false;
  if (target === document.body || target === document.documentElement) return true;
  return target instanceof Node && panel.contains(target);
}
