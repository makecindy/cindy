import { requireOptionalNativeModule } from "expo-modules-core";
import { randomUUID } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { AppState, Platform } from "react-native";
import { receivePluginOauthLoopback, type MobileLoopbackNative, type MobileLoopbackRequest } from "./pluginOauthLoopback";
export function receiveMobilePluginOauthLoopback(
  request: MobileLoopbackRequest, expiresAt: number, assertCurrent: () => void, signal?: AbortSignal,
) {
  return receivePluginOauthLoopback({
    request, expiresAt, signal, assertCurrent, id: randomUUID(), platform: Platform.OS,
    native: requireOptionalNativeModule<MobileLoopbackNative>("CindyPluginOauth"),
    openBrowser: (url) => WebBrowser.openBrowserAsync(url, { showTitle: true }),
    dismissBrowser: async () => { await WebBrowser.dismissBrowser(); },
    onAppState: (listener) => {
      const subscription = AppState.addEventListener("change", listener);
      return () => subscription.remove();
    },
  });
}
