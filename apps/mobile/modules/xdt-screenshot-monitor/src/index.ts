import {
  requireOptionalNativeModule,
  type EventSubscription,
} from 'expo-modules-core';

export type ScreenshotEvent = {
  capturedAt: number;
};

type ScreenshotMonitorNativeModule = {
  addListener(
    eventName: 'onScreenshot',
    listener: (event: ScreenshotEvent) => void,
  ): EventSubscription;
  renderConversationShareHtmlToPng?(options: {
    html: string;
    width: number;
    scale: number;
  }): Promise<string>;
};

const nativeModule = requireOptionalNativeModule<ScreenshotMonitorNativeModule>(
  'XdtScreenshotMonitor',
);

export function addScreenshotListener(
  listener: (event: ScreenshotEvent) => void,
): EventSubscription | null {
  return nativeModule?.addListener('onScreenshot', listener) ?? null;
}

export const conversationShareNativeRendererAvailable =
  typeof nativeModule?.renderConversationShareHtmlToPng === 'function';

export async function renderConversationShareHtmlToPng(options: {
  html: string;
  width: number;
  scale?: number;
}): Promise<string | null> {
  if (!nativeModule?.renderConversationShareHtmlToPng) return null;
  return nativeModule.renderConversationShareHtmlToPng({
    html: options.html,
    width: options.width,
    scale: options.scale ?? 2,
  });
}
