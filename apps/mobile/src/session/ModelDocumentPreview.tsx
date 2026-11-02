import { useEffect, useMemo, useRef, useState } from "react";
import { File } from "expo-file-system";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { RotateCcw, Minus, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { spacing, textStyles, useTheme } from "@/theme";
import { PreviewIconButton } from "./PreviewChrome";
import { MOBILE_MODEL_JS } from "./documentPreviewAssets.generated";

/** Receives an already authorized local copy. The viewer cannot fetch other files or networks. */
export function ModelDocumentPreview({
  uri,
  name,
}: {
  uri: string;
  name: string;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const web = useRef<WebView>(null);
  const [data, setData] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let canceled = false;
    setData(null);
    setFailed(false);
    setReady(false);
    void Promise.resolve()
      .then(() => {
        const file = new File(uri);
        if (file.size > 50 * 1024 * 1024) throw new Error("PREVIEW_TOO_LARGE");
        return file.base64();
      })
      .then((value) => {
        if (!canceled) setData(value);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [uri, retry]);
  const html = useMemo(
    () =>
      data
        ? `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;connect-src data: blob:;worker-src blob:"><style>html,body{height:100%;margin:0;background:${colors.surface}}model-viewer{width:100%;height:100%}</style></head><body><script>${MOBILE_MODEL_JS.replace(/<\/script/gi, "<\\/script")}</script><model-viewer id="model" camera-controls autoplay interaction-prompt="none" shadow-intensity="0.8" src="data:${name.toLowerCase().endsWith(".gltf") ? "model/gltf+json" : "model/gltf-binary"};base64,${data}"></model-viewer><script>const model=document.getElementById('model');model.addEventListener('load',()=>window.ReactNativeWebView.postMessage('ready'));model.addEventListener('error',()=>window.ReactNativeWebView.postMessage('error'));window.__cindyModelZoom=(factor)=>{const orbit=model.getCameraOrbit();model.cameraOrbit=orbit.theta+'rad '+orbit.phi+'rad '+orbit.radius*factor+'m';};window.__cindyModelReset=()=>{model.cameraOrbit='0deg 75deg auto';model.cameraTarget='auto auto auto';model.fieldOfView='auto';};</script></body></html>`
        : null,
    [data, name, colors.surface],
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {html && !failed ? (
        <WebView
          ref={web}
          source={{ html }}
          originWhitelist={["about:*"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank"
          }
          onMessage={(event) => {
            if (event.nativeEvent.data === "ready") setReady(true);
            if (event.nativeEvent.data === "error") setFailed(true);
          }}
          onError={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: colors.surface }}
        />
      ) : null}
      {!ready || failed ? (
        <View
          pointerEvents={failed ? "auto" : "none"}
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: "center",
              justifyContent: "center",
              padding: spacing.lg,
            },
          ]}
        >
          {failed ? (
            <>
              <Text
                style={[textStyles.footnote, { color: colors.textSecondary }]}
              >
                {t("files.preview.readFailed")}
              </Text>
              <Pressable
                style={{ minHeight: 48, justifyContent: "center" }}
                onPress={() => setRetry((value) => value + 1)}
              >
                <Text style={[textStyles.body, { color: colors.textPrimary }]}>
                  {t("message.attachmentPreview.retry")}
                </Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )}
        </View>
      ) : null}
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
        }}
      >
        <PreviewIconButton
          icon={Minus}
          label={t("message.attachmentPreview.zoomOut")}
          disabled={!ready || failed}
          onPress={() =>
            web.current?.injectJavaScript(
              "window.__cindyModelZoom?.(1.25);true;",
            )
          }
        />
        <PreviewIconButton
          icon={RotateCcw}
          label={t("message.attachmentPreview.reset")}
          disabled={!ready || failed}
          onPress={() =>
            web.current?.injectJavaScript("window.__cindyModelReset?.();true;")
          }
        />
        <PreviewIconButton
          icon={Plus}
          label={t("message.attachmentPreview.zoomIn")}
          disabled={!ready || failed}
          onPress={() =>
            web.current?.injectJavaScript(
              "window.__cindyModelZoom?.(0.8);true;",
            )
          }
        />
      </View>
    </View>
  );
}
