import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { spacing, textStyles, useTheme } from "@/theme";
import { PreviewIconButton } from "./PreviewChrome";
import { Minus, Plus, Scan } from "lucide-react-native";
import {
  MermaidDiagramWebView,
  type MermaidDiagramWebViewHandle,
} from "./mermaidWebView";
import { MOBILE_DRAWIO_JS } from "./documentPreviewAssets.generated";

/** The same offline draw.io distribution as desktop; document data never becomes script. */
export function DiagramDocumentPreview({
  source,
  name,
}: {
  source: string;
  name: string;
}) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const diagram = useRef<MermaidDiagramWebViewHandle>(null);
  const [failed, setFailed] = useState(false);
  const drawio = /\.(drawio(?:\.svg)?|dio)$/i.test(name);
  const html = useMemo(() => {
    const options = JSON.stringify({
      xml: source,
      nav: true,
      resize: true,
      toolbar: "zoom layers pages",
      "dark-mode": mode === "dark" ? "1" : "0",
      "check-visible-state": false,
    }).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;font-src data:"><style>html,body{margin:0;min-height:100%;background:${colors.surface}}#diagram{width:100%;min-height:100vh}</style><script>var mxLoadResources=false;var mxLoadStylesheets=false;</script><script>${MOBILE_DRAWIO_JS.replace(/<\/script/gi, "<\\/script")}</script></head><body><div id="diagram" class="mxgraph"></div><script>try{const el=document.getElementById('diagram');el.setAttribute('data-mxgraph',JSON.stringify(${options}));GraphViewer.createViewerForElement(el);}catch{window.ReactNativeWebView.postMessage('error');}</script></body></html>`;
  }, [source, colors.surface, mode]);
  if (!drawio)
    return (
      <View style={styles.fill}>
        <MermaidDiagramWebView
          ref={diagram}
          source={source}
          fill
          bare
          zoomable
          deferSource
        />
        <View
          style={{
            height: 56,
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: colors.surface,
          }}
        >
          <PreviewIconButton
            icon={Minus}
            label={t("message.attachmentPreview.zoomOut")}
            onPress={() => diagram.current?.zoom(0.8)}
          />
          <PreviewIconButton
            icon={Scan}
            label={t("message.attachmentPreview.fit")}
            onPress={() => diagram.current?.zoom("fit")}
          />
          <PreviewIconButton
            icon={Plus}
            label={t("message.attachmentPreview.zoomIn")}
            onPress={() => diagram.current?.zoom(1.25)}
          />
        </View>
      </View>
    );
  if (failed)
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: spacing.lg }}>
        <Text style={[textStyles.body, { color: colors.textSecondary }]}>
          {t("files.preview.readFailed")}
        </Text>
        <Pressable
          onPress={() => setFailed(false)}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Text style={[textStyles.body, { color: colors.textPrimary }]}>
            {t("message.attachmentPreview.retry")}
          </Text>
        </Pressable>
      </View>
    );
  return (
    <WebView
      key={`${name}:${mode}`}
      source={{ html }}
      originWhitelist={["about:*"]}
      onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
      onMessage={(event) => {
        if (event.nativeEvent.data === "error") setFailed(true);
      }}
      onError={() => setFailed(true)}
      allowFileAccess={false}
      allowUniversalAccessFromFileURLs={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      style={styles.fill}
    />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
