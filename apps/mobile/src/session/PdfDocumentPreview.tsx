import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { File } from "expo-file-system";
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minus,
  Plus,
  Search,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import {
  lineHeight,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { PreviewIconButton } from "./PreviewChrome";
import { preparePdfPreviewSource } from "./pdfPreviewSource";
import { buildPdfWebViewHtml } from "./pdfWebViewHtml";

/** PDF.js on both native WebViews: real selectable pages, bounded raster memory, offline fonts. */
export function PdfDocumentPreview({ uri }: { uri: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const web = useRef<WebView>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const [oversize, setOversize] = useState(false);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState({ page: 1, pages: 0, zoom: 1 });
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [find, setFind] = useState(false);
  const [matches, setMatches] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let release: (() => void) | undefined;
    setBase64(null);
    setFailure(false);
    setOversize(false);
    setPassword("");
    setPasswordNeeded(false);
    setStatus({ page: 1, pages: 0, zoom: 1 });
    setMatches(null);
    setQuery("");
    void preparePdfPreviewSource(uri, abort.signal)
      .then(async (source) => {
        release = source.release;
        if (cancelled) {
          release();
          return;
        }
        const file = new File(source.uri);
        if (file.size > 30 * 1024 * 1024) {
          setOversize(true);
          return;
        }
        const bytes = await file.base64();
        if (!cancelled) setBase64(bytes);
      })
      .catch((error) => {
        if (!cancelled) {
          if (error instanceof Error && error.message === "PDF_TOO_LARGE")
            setOversize(true);
          else setFailure(true);
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
      release?.();
    };
  }, [uri, retry]);
  const html = useMemo(
    () => (base64 ? buildPdfWebViewHtml(base64, colors) : null),
    [base64, colors.surface, colors.textPrimary],
  );
  const command = (value: Record<string, unknown>) =>
    web.current?.injectJavaScript(
      `window.__cindyPdfCommand?.(${JSON.stringify(value).replace(/</g, "\\u003c")});true;`,
    );
  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (
        data.type === "status" &&
        Number.isFinite(data.pages) &&
        Number.isFinite(data.page) &&
        Number.isFinite(data.zoom)
      )
        setStatus({ page: data.page, pages: data.pages, zoom: data.zoom });
      else if (data.type === "error") setFailure(true);
      else if (data.type === "password") setPasswordNeeded(true);
      else if (data.type === "search" && Number.isFinite(data.matches))
        setMatches(data.matches);
    } catch {
      /* Unrecognized renderer messages cannot invoke host actions. */
    }
  };
  return (
    <View style={styles.root} testID="preview.pdf">
      {failure || oversize ? (
        <View style={styles.center}>
          <Text style={styles.text}>
            {oversize
              ? t("files.preview.oversize", { size: "30 MB" })
              : t("files.preview.readFailed")}
          </Text>
          {!oversize ? (
            <Pressable onPress={() => setRetry((value) => value + 1)}>
              <Text style={styles.text}>
                {t("message.attachmentPreview.retry")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : html ? (
        <WebView
          key={`${uri}:${retry}`}
          ref={web}
          source={{ html }}
          originWhitelist={["about:*"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank"
          }
          onMessage={onMessage}
          onError={() => setFailure(true)}
          onContentProcessDidTerminate={() => setFailure(true)}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          style={styles.root}
        />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.text}>{t("files.preview.fetchingPdf")}</Text>
        </View>
      )}
      {passwordNeeded ? (
        <View style={styles.prompt}>
          <Text style={styles.text}>
            {t("message.attachmentPreview.password")}
          </Text>
          <TextInput
            accessibilityLabel={t("message.attachmentPreview.password")}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={[styles.input, { flex: 0, width: "100%" }]}
            onSubmitEditing={() => {
              command({ type: "password", value: password });
              setPassword("");
              setPasswordNeeded(false);
            }}
          />
          <Pressable
            onPress={() => {
              command({ type: "password", value: password });
              setPassword("");
              setPasswordNeeded(false);
            }}
          >
            <Text style={styles.text}>
              {t("message.attachmentPreview.open")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {find ? (
        <View style={styles.search}>
          <TextInput
            accessibilityLabel={t("message.attachmentPreview.find")}
            placeholder={t("message.attachmentPreview.find")}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => command({ type: "find", value: query })}
            style={styles.input}
            returnKeyType="search"
          />
          <PreviewIconButton
            icon={Search}
            label={t("message.attachmentPreview.find")}
            onPress={() => command({ type: "find", value: query })}
          />
          {matches !== null ? (
            <Text style={styles.meta}>
              {t("message.attachmentPreview.matches", { count: matches })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {status.pages > 0 && !failure ? (
        <View>
          <View style={styles.tools}>
            <PreviewIconButton
              icon={ChevronLeft}
              label={t("message.attachmentPreview.previousPage")}
              disabled={status.page <= 1}
              onPress={() => command({ type: "page", value: status.page - 1 })}
            />
            <Text style={styles.meta}>
              {status.page} / {status.pages}
            </Text>
            <PreviewIconButton
              icon={ChevronRight}
              label={t("message.attachmentPreview.nextPage")}
              disabled={status.page >= status.pages}
              onPress={() => command({ type: "page", value: status.page + 1 })}
            />
          </View>
          <View style={styles.tools}>
            <PreviewIconButton
              icon={Minus}
              label={t("message.attachmentPreview.zoomOut")}
              onPress={() =>
                command({ type: "zoom", value: status.zoom / 1.25 })
              }
            />
            <PreviewIconButton
              icon={Maximize}
              label={t("message.attachmentPreview.fit")}
              onPress={() => command({ type: "zoom", value: 1 })}
            />
            <PreviewIconButton
              icon={Plus}
              label={t("message.attachmentPreview.zoomIn")}
              onPress={() =>
                command({ type: "zoom", value: status.zoom * 1.25 })
              }
            />
            <PreviewIconButton
              icon={Search}
              label={t("message.attachmentPreview.find")}
              onPress={() => setFind((value) => !value)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.md,
      padding: spacing.lg,
    },
    text: {
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
    },
    meta: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    tools: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      minHeight: 56,
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    search: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.sm,
    },
    input: {
      flex: 1,
      minHeight: 48,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      paddingHorizontal: spacing.md,
    },
    prompt: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.surface,
      justifyContent: "center",
      alignItems: "center",
      padding: spacing.lg,
    },
  });
