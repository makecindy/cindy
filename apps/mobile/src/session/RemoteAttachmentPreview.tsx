import { usePreviewChromeFrame } from "./usePreviewChromeFrame";
import { ImageLightbox } from "./ImageLightbox";
import { buildMediaPayload, type AudioAttachmentPhase } from "./messagePayload";
import {
  BotGroupTextAttachmentPreview,
  botGroupTextAttachmentPreviewKind,
} from "./BotGroupTextAttachmentPreview";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useTranslation } from "react-i18next";
import { attachmentPreviewKind } from "@cindy/maker-shared/attachment-preview";
import { Text } from "@/components/AppText";
import { spacing, textStyles, useTheme } from "@/theme";
import {
  PreviewHeader,
  PreviewFooter,
} from "./PreviewChrome";
import { PdfDocumentPreview } from "./PdfDocumentPreview";
import { ModelDocumentPreview } from "./ModelDocumentPreview";
import { NativeVideoPlayer } from "./NativeVideoPlayer";
import { AudioAttachmentPlayer } from "./AudioAttachmentPlayer";
import { RemoteMediaPlayerWebView } from "./mediaPlayerWebView";
import type { MobileMediaPlayerStatus } from "./mediaPlayerWebViewHtml";
import { resolvedUrlKind } from "@/debug/fileDiagnostics";
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import { downloadRemoteMediaShareTemp } from "./remoteMediaDiskCacheExpo";

export interface ResolvedPreviewFile {
  url: string;
  mimeType?: string;
  size?: number;
  protectLocalFile?(): () => void;
}

/** The caller authorizes each open. URLs remain transport references, never share payloads. */
export function RemoteAttachmentPreview(props: {
  name: string;
  mediaKind?: 'audio' | 'video';
  resolve(signal: AbortSignal, forceRefresh?: boolean): Promise<ResolvedPreviewFile>;
  onAudioPhaseChange?: (phase: AudioAttachmentPhase) => void;
  onClose(): void;
}) {
  const resolver = useRef(props.resolve);
  resolver.current = props.resolve;
  const requests = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const request of requests.current) request.abort();
      requests.current.clear();
    },
    [],
  );
  const resolve = useCallback(async (signal?: AbortSignal, forceRefresh?: boolean) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    requests.current.add(controller);
    signal?.addEventListener("abort", abort);
    try {
      if (signal?.aborted) throw new Error("ABORTED");
      const result = await resolver.current(controller.signal, forceRefresh);
      if (controller.signal.aborted) throw new Error("ABORTED");
      return result;
    } finally {
      requests.current.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }, []);
  const textKind = props.mediaKind ? null : botGroupTextAttachmentPreviewKind(props.name);
  if (textKind)
    return (
      <BotGroupTextAttachmentPreview
        attachmentId={props.name}
        fileName={props.name}
        kind={textKind}
        deviceSource={props.name}
        resolveDeviceMedia={async (_, options) => ({
          ossKey: "",
          size: 0,
          expiresAt: "",
          previewable: true,
          mimeType: "application/octet-stream",
          ...(await resolve(options?.signal)),
        })}
        onClose={props.onClose}
      />
    );
  if (!props.mediaKind && attachmentPreviewKind(props.name) === "image")
    return (
      <ImageLightbox
        resolveOpaqueSource
        images={[
          {
            key: props.name,
            title: props.name,
            url: props.name,
            payload: buildMediaPayload(
              { kind: "image", url: props.name, previewable: false },
              props.name,
            ),
          },
        ]}
        initialUrl={props.name}
        onResolveRemoteMedia={async (_, options) => ({
          ossKey: "",
          size: 0,
          expiresAt: "",
          previewable: true,
          mimeType: "application/octet-stream",
          ...(await resolve(options?.signal)),
        })}
        onShareImage={async (_image, uri, mimeType) => {
          const copy = await downloadRemoteMediaShareTemp(
            uri,
            mimeType ?? "application/octet-stream",
            props.name,
          );
          if (!copy) throw new Error("PREVIEW_DOWNLOAD_FAILED");
          try {
            await Sharing.shareAsync(copy, { mimeType });
          } finally {
            remove(copy);
          }
        }}
        onClose={props.onClose}
      />
    );
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={props.onClose}
    >
      <SafeAreaProvider>
        <RemoteAttachmentBody {...props} resolve={resolve} />
      </SafeAreaProvider>
    </Modal>
  );
}

function RemoteAttachmentBody({
  name,
  mediaKind,
  resolve,
  onAudioPhaseChange,
  onClose,
}: {
  name: string;
  mediaKind?: 'audio' | 'video';
  resolve(signal: AbortSignal, forceRefresh?: boolean): Promise<ResolvedPreviewFile>;
  onAudioPhaseChange?: (phase: AudioAttachmentPhase) => void;
  onClose(): void;
}) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const chromeFrame = usePreviewChromeFrame();
  const shareAbort = useRef<AbortController | null>(null);
  const resolver = useRef(resolve);
  resolver.current = resolve;
  const [file, setFile] = useState<ResolvedPreviewFile | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const lastAudioPhase = useRef<AudioAttachmentPhase>('idle');
  const reportAudioPhase = useCallback((phase: AudioAttachmentPhase) => {
    if (lastAudioPhase.current === phase) return;
    lastAudioPhase.current = phase;
    onAudioPhaseChange?.(phase);
  }, [onAudioPhaseChange]);
  const handleAudioStatus = useCallback(({ state }: MobileMediaPlayerStatus) => {
    if (state === 'error') {
      reportAudioPhase('error');
    } else if (lastAudioPhase.current === 'loading' && (state === 'ready' || state === 'playing')) {
      reportAudioPhase('ready');
    }
  }, [reportAudioPhase]);
  const [retry, setRetry] = useState(0);
  const refreshOnRetry = useRef(false);
  const [sharing, setSharing] = useState(false);
  const alive = useRef(true);
  const shareWork = useRef<Promise<void> | null>(null);
  const kind = mediaKind ?? attachmentPreviewKind(name, file?.mimeType);
  const reload = (forceRefresh = false) => {
    refreshOnRetry.current = forceRefresh;
    setFile(null);
    setFailed(false);
    setRetry((value) => value + 1);
  };
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    let owned: string | null = null;
    let releaseSource: (() => void) | undefined;
    setFile(null);
    setLocal(null);
    setFailed(false);
    setNativeFailed(false);
    reportAudioPhase('loading');
    if (mediaKind === 'audio') mobileDebugLog('debug', 'files', 'audio attachment fetch start', { retry: retry > 0 });
    void resolver
      .current(abort.signal, refreshOnRetry.current)
      .then(async (value) => {
        if (abort.signal.aborted) return;
        releaseSource = value.protectLocalFile?.();
        setFile(value);
        if (mediaKind === 'audio') mobileDebugLog('debug', 'files', 'audio attachment source resolved', {
          source: resolvedUrlKind(value.url), mimeType: value.mimeType, size: value.size,
        });
        if (mediaKind || attachmentPreviewKind(name, value.mimeType) !== "model") return;
        owned = await downloadRemoteMediaShareTemp(
          value.url,
          value.mimeType ?? "application/octet-stream",
          name,
          abort.signal,
        );
        if (!owned) throw new Error("PREVIEW_DOWNLOAD_FAILED");
        if (abort.signal.aborted) {
          remove(owned);
          return;
        }
        setLocal(owned);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setFailed(true);
        reportAudioPhase('error');
        if (mediaKind === 'audio') mobileDebugLog('warn', 'files', 'audio attachment fetch failed', { retry: retry > 0 });
      });
    return () => {
      alive.current = false;
      abort.abort();
      shareAbort.current?.abort();
      if (lastAudioPhase.current === 'loading') reportAudioPhase('idle');
      void Promise.resolve(shareWork.current)
        .finally(() => {
          if (owned) remove(owned);
          releaseSource?.();
        })
        .catch(() => {});
    };
  }, [mediaKind, name, reportAudioPhase, retry]);
  const share = useCallback(() => {
    if (shareWork.current || !file) return;
    setSharing(true);
    const request = new AbortController();
    shareAbort.current = request;
    const work = (async () => {
      let uri = local;
      try {
        if (!uri)
          uri = await downloadRemoteMediaShareTemp(
            file.url,
            file.mimeType ?? "application/octet-stream",
            name,
            request.signal,
          );
        if (!uri) throw new Error("PREVIEW_DOWNLOAD_FAILED");
        if (alive.current)
          await Sharing.shareAsync(uri, { mimeType: file.mimeType });
      } catch {
        if (alive.current) Alert.alert(t("groupChat.server.attachmentFailed"));
      } finally {
        if (uri && uri !== local) remove(uri);
        if (alive.current) setSharing(false);
        shareWork.current = null;
      }
    })();
    shareWork.current = work;
  }, [file, local, name, t]);
  const center = (text: string) => (
    <View style={styles.center}>
      <Text style={[textStyles.body, { color: colors.textSecondary }]}>
        {text}
      </Text>
    </View>
  );
  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      {kind === 'audio' && Platform.OS === 'android' ? (
        <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} />
      ) : null}
      <View
        style={[
          styles.root,
          {
            paddingTop: chromeFrame.documentContentTop,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        {kind === "audio" ? (
          <AudioAttachmentPlayer
            key={retry}
            name={name}
            source={file}
            readFailed={failed}
            onStatusChange={handleAudioStatus}
            onRetry={() => reload(true)}
          />
        ) : failed ? (
          <View style={styles.center}>
            <Text style={[textStyles.body, { color: colors.textSecondary }]}>
              {t("files.preview.readFailed")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => reload()}
              style={styles.retry}
              testID="message.attachmentPreviewRetry"
            >
              <Text style={[textStyles.body, { color: colors.textPrimary }]}>
                {t("message.attachmentPreview.retry")}
              </Text>
            </Pressable>
          </View>
        ) : !file ? (
          <View style={styles.center} testID="message.attachmentPreviewLoading">
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : kind === "pdf" ? (
          <PdfDocumentPreview uri={file.url} />
        ) : kind === "model" ? (
          local ? (
            <ModelDocumentPreview uri={local} name={name} />
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          )
        ) : kind === "video" && !nativeFailed ? (
          <NativeVideoPlayer
            url={file.url}
            visible
            onError={() => setNativeFailed(true)}
            style={styles.root}
          />
        ) : kind === "video" ? (
          <RemoteMediaPlayerWebView
            kind={kind}
            url={file.url}
            mimeType={file.mimeType}
            title={name}
            style={styles.root}
          />
        ) : (
          center(t("files.preview.unsupportedType"))
        )}
      </View>
      <PreviewFooter />
      <PreviewHeader
        name={name}
        showTitle={kind !== "audio"}
        detail={file?.mimeType}
        onClose={onClose}
        actions={[
          {
            key: "share",
            label: t("message.attachmentPreview.share"),
            onPress: share,
            disabled: !file || sharing,
          },
        ]}
      />
    </View>
  );
}

function remove(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* OS may already have reclaimed the cache. */
  }
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  retry: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
  },
});
