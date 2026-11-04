// Native black-box runner supplies captured pixels and live helper replies.
// Only the transport is adapted; selection, pointer/wheel handling and painting
// all run through the production overlay. No expected rectangle enters the UI.
import { mountPage } from '../../ui-page/harness';
import { RegionScreenshotOverlay } from '../../../src/renderer/features/region-screenshot/RegionScreenshotOverlay';
import type { RegionScreenshotBegin, RegionScreenshotHit } from '../../../src/shared/regionScreenshot';
import type { RegionScreenshotOverlayBridge } from '../../../src/renderer/features/region-screenshot/bridge';

const native = window as unknown as {
  nativeBegin: RegionScreenshotBegin;
  nativeElements: (x: number, y: number) => Promise<RegionScreenshotHit>;
};
mountPage({ render: () => {
  let begin: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0] | undefined;
  const bridge = {
    onBegin: (callback: typeof begin) => { begin = callback; return () => { begin = undefined; }; },
    onEnd: () => () => {}, onClear: () => () => {},
    shellReady: () => queueMicrotask(() => begin?.({ ...native.nativeBegin,
      frame: { ...native.nativeBegin.frame, data: new Uint8Array(native.nativeBegin.frame.data) },
    })),
    elementsAt: (_token: string, _window: number, x: number, y: number) => native.nativeElements(x, y),
    painted() {}, focused() {}, selectionStarted() {}, abandon() {}, cancel() {}, copyText() {},
  } as RegionScreenshotOverlayBridge;
  return <RegionScreenshotOverlay bridge={bridge} />;
} });
