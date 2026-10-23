import { isPreviewViewport, type PreviewViewport } from "@cindy/device-link";
import type { PreviewViewportInsets } from "./previewInsets";

/** Rotation and split-view changes settle before the computer re-lays out the tab. */
export const PREVIEW_VIEWPORT_DEBOUNCE_MS = 300;

/**
 * The picture area in CSS px: the window less what the fit leaves to the
 * controls. Null when it is not a size the host accepts (not laid out yet).
 */
export function previewPictureArea(input: {
  windowWidth: number;
  windowHeight: number;
  insets: PreviewViewportInsets;
}): PreviewViewport | null {
  const area = {
    width: Math.round(input.windowWidth - input.insets.left - input.insets.right),
    height: Math.round(input.windowHeight - input.insets.top - input.insets.bottom),
  };
  return isPreviewViewport(area) ? area : null;
}

const same = (a: PreviewViewport | null, b: PreviewViewport | null) =>
  a?.width === b?.width && a?.height === b?.height;

/**
 * Tells a host that advertises `previewTab.viewport` when the picture area
 * changed, debounced. The area the host already has (sent with `previewStart`,
 * or the last accepted change) is never sent again; a refused change leaves it
 * unconfirmed, so the next change goes out.
 */
export function createPreviewViewportReporter(
  send: (viewport: PreviewViewport) => Promise<unknown> | void,
  delayMs = PREVIEW_VIEWPORT_DEBOUNCE_MS,
) {
  let known: PreviewViewport | null = null;
  let latest: PreviewViewport | null = null;
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    if (!enabled || !latest || same(latest, known)) return;
    const wanted = latest;
    const mine = generation;
    timer = setTimeout(() => {
      timer = null;
      void Promise.resolve(send(wanted)).then(
        () => {
          if (mine === generation) known = wanted;
        },
        () => {},
      );
    }, delayMs);
  };
  return {
    /** A preview lease is live. `sent` is what `previewStart` carried, if anything. */
    start(sent: PreviewViewport | null, supported: boolean) {
      generation++;
      known = sent;
      enabled = supported;
      schedule();
    },
    /** The current picture area; the keyboard must not reach here. */
    update(area: PreviewViewport | null) {
      latest = area;
      schedule();
    },
    stop() {
      generation++;
      enabled = false;
      cancel();
    },
  };
}
