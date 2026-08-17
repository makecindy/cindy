import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { Directory, File, Paths } from "expo-file-system";
import { Image as NativeImage, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { interceptHtmlNavigation } from "@/session/htmlNavigationPolicy";

const EXPORT_TIMEOUT_MS = 20_000;
const EXPORT_SCALE = 2;
const EXPORT_DIR_NAME = "conversation-share";

export interface ConversationShareWebViewHandle {
  exportPng(options?: { scale?: number }): Promise<string>;
}

interface PendingExport {
  resolve: (base64: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ReadyWaiter = (error: Error | null) => void;

export const ConversationShareWebView = forwardRef<
  ConversationShareWebViewHandle,
  {
    html: string;
  }
>(function ConversationShareWebView({ html }, ref) {
  const webViewRef = useRef<WebView | null>(null);
  const pendingRef = useRef(new Map<string, PendingExport>());
  const sequenceRef = useRef(0);
  const readyRef = useRef(false);
  const readyWaitersRef = useRef<ReadyWaiter[]>([]);
  const documentSettledRef = useRef(false);
  const lastHtmlRef = useRef(html);

  if (lastHtmlRef.current !== html) {
    lastHtmlRef.current = html;
    documentSettledRef.current = false;
  }

  useEffect(() => {
    readyRef.current = false;
  }, [html]);

  useImperativeHandle(
    ref,
    () => ({
      async exportPng(options) {
        if (!readyRef.current) {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const waiter: ReadyWaiter = (error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              readyWaitersRef.current = readyWaitersRef.current.filter(
                (candidate) => candidate !== waiter,
              );
              if (error) reject(error);
              else resolve();
            };
            const timer = setTimeout(
              () => waiter(new Error("conversation share webview not ready")),
              EXPORT_TIMEOUT_MS,
            );
            readyWaitersRef.current.push(waiter);
          });
        }
        return new Promise<string>((resolve, reject) => {
          const webView = webViewRef.current;
          if (!webView) {
            reject(new Error("conversation share webview not ready"));
            return;
          }
          sequenceRef.current += 1;
          const id = `conversation-share-${sequenceRef.current}`;
          const timer = setTimeout(() => {
            pendingRef.current.delete(id);
            reject(new Error("conversation share export timed out"));
          }, EXPORT_TIMEOUT_MS);
          pendingRef.current.set(id, { resolve, reject, timer });
          const scale = options?.scale ?? EXPORT_SCALE;
          webView.injectJavaScript(`(function () {
  if (window.__cindyConversationShareExportPng) {
    window.__cindyConversationShareExportPng(${JSON.stringify(id)}, ${JSON.stringify(scale)});
  } else if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'conversation-share-export', id: ${JSON.stringify(id)}, ok: false, error: 'not-ready' }));
  }
})(); true;`);
        });
      },
    }),
    [],
  );

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      base64?: unknown;
      error?: unknown;
    };
    if (record.type === "conversation-share-ready") {
      readyRef.current = true;
      const waiters = readyWaitersRef.current.splice(0);
      waiters.forEach((waiter) => waiter(null));
      return;
    }
    if (
      record.type !== "conversation-share-export" ||
      typeof record.id !== "string"
    )
      return;
    const pending = pendingRef.current.get(record.id);
    if (!pending) return;
    pendingRef.current.delete(record.id);
    clearTimeout(pending.timer);
    if (
      record.ok === true &&
      typeof record.base64 === "string" &&
      record.base64.length > 0
    ) {
      pending.resolve(record.base64);
    } else {
      pending.reject(
        new Error(
          typeof record.error === "string"
            ? record.error
            : "conversation share export failed",
        ),
      );
    }
  }, []);

  const interceptNavigation = useCallback(
    (request: ShouldStartLoadRequest) =>
      interceptHtmlNavigation(request, documentSettledRef.current),
    [],
  );

  useEffect(
    () => () => {
      const unmountedError = new Error("conversation share webview unmounted");
      readyWaitersRef.current.splice(0).forEach((waiter) => waiter(unmountedError));
      for (const pending of pendingRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(unmountedError);
      }
      pendingRef.current.clear();
    },
    [],
  );

  const source = useMemo(
    () => ({ html, baseUrl: "about:blank" }),
    [html],
  );

  return (
    <View pointerEvents="none" style={styles.hidden}>
      <WebView
        javaScriptEnabled
        onMessage={handleMessage}
        onLoadEnd={() => {
          documentSettledRef.current = true;
        }}
        onShouldStartLoadWithRequest={interceptNavigation}
        originWhitelist={["*"]}
        ref={webViewRef}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        mediaCapturePermissionGrantType="deny"
        source={source}
        style={styles.webView}
      />
    </View>
  );
});

export async function bundledAssetToDataUri(
  asset: number,
  mimeType: string,
): Promise<string | null> {
  try {
    const source = NativeImage.resolveAssetSource(asset);
    const uri = source?.uri;
    if (!uri) return null;
    if (uri.startsWith("data:")) return uri;

    if (uri.startsWith("file://") || uri.startsWith("/")) {
      const FileSystem = await import("expo-file-system/legacy");
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return base64 ? `data:${mimeType};base64,${base64}` : null;
    }

    const response = await fetch(uri);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const base64 = typeof btoa === "function" ? btoa(binary) : encodeBase64(bytes);
    return base64 ? `data:${mimeType};base64,${base64}` : null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return output;
}

export async function writeConversationSharePngTemp(
  base64: string,
): Promise<string | null> {
  let fileUri: string | null = null;
  try {
    const directory = new Directory(Paths.cache, EXPORT_DIR_NAME);
    directory.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const file = new File(directory, `conversation-${unique}.png`);
    fileUri = file.uri;
    const FileSystem = await import("expo-file-system/legacy");
    await FileSystem.writeAsStringAsync(file.uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if ((file.size ?? 0) > 0) return file.uri;
    await deleteConversationSharePngTemp(file.uri);
    return null;
  } catch {
    if (fileUri) await deleteConversationSharePngTemp(fileUri);
    return null;
  }
}

export async function deleteConversationSharePngTemp(uri: string): Promise<void> {
  if (!uri) return;
  try {
    const FileSystem = await import("expo-file-system/legacy");
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // 一次性缓存清理是 best-effort，不覆盖原分享操作的结果。
  }
}

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 1,
  },
  webView: { height: 1, width: 1 },
});
