import { TextDocumentPreview } from "./TextDocumentPreview";
import {
  useCallback,
  useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react-native';
import { ActivityIndicator,
  Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { openBrowserAsync } from 'expo-web-browser';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import { extractRemoteFileExt, isHtmlFilePreviewCandidate, remoteFilePreviewKind } from '@cindy/maker-shared/file-preview';
import { Text } from '@/components/AppText';
import * as Sharing from "expo-sharing";
import { File } from "expo-file-system";
import type { ResolveRemoteMediaFn } from "./remoteMedia";
import {
  PreviewHeader,
  PreviewFooter,
  PreviewCollectionContext,
} from "./PreviewChrome";
import { DiagramDocumentPreview } from "./DiagramDocumentPreview";
import { downloadRemoteMediaShareTemp } from "./remoteMediaDiskCacheExpo";
import { HtmlFileReader } from '@/session/HtmlFileReader';
import { MarkdownFileReader } from '@/session/MarkdownFileReader';
import { withDownloadedRemoteMediaFile } from '@/session/remoteMediaDiskCacheExpo';
import { iconSize, radius, spacing, textStyles, useTheme } from '@/theme';

const TEXT_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const NO_EXTERNAL_IMAGES: ReadonlyMap<string, { uri: string }> = new Map();

export type BotGroupTextAttachmentPreviewKind = 'html' | 'markdown' | 'json' | "text" | "diagram";

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'empty' }
  | { status: 'failed' }
  | { status: 'too-large' }
  | { status: 'binary' };

type ResolveServerMedia = (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>;

type ReadResult = { kind: 'text'; text: string } | { kind: 'binary' };

export function botGroupTextAttachmentPreviewKind(name: string): BotGroupTextAttachmentPreviewKind | null {
  if (remoteFilePreviewKind(name) === "drawio" ||
    /\.(mmd|mermaid)$/i.test(name)
  )
    return "diagram";
  if (remoteFilePreviewKind(name) !== 'text') return null;
  if (isHtmlFilePreviewCandidate(name)) return 'html';
  const extension = extractRemoteFileExt(name);
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.json') return 'json';
  return "text";
}

export function BotGroupTextAttachmentPreview({ attachmentId, fileName, kind, resolve,
  resolveDeviceMedia,
  deviceSource, onClose }: {
  attachmentId: string;
  fileName: string;
  kind: BotGroupTextAttachmentPreviewKind;
  resolve?: ResolveServerMedia;
  resolveDeviceMedia?: ResolveRemoteMediaFn;
  deviceSource?: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const collection = useContext(PreviewCollectionContext);
  const [source, setSource] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const controller = useRef<AbortController | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const deviceRef = useRef(resolveDeviceMedia);
  deviceRef.current = resolveDeviceMedia;
  const authorizedSource = async (signal?: AbortSignal) => {
    if (deviceRef.current && deviceSource)
      return deviceRef.current(
        { kind: "file", url: deviceSource, previewable: false },
        { front: true, signal },
      );
    if (!resolveRef.current) throw new Error("ATTACHMENT_RESOLVER_MISSING");
    const attachment = await resolveRef.current(attachmentId, signal);
      if (attachment.category !== 'file' || !attachment.url || !isCredentialFreeHttpsUrl(attachment.url))
      throw new Error('ATTACHMENT_PREVIEW_URL_INVALID');
    return { url: attachment.url, mimeType: attachment.mimeType };
  };
  const authorizedRef = useRef(authorizedSource);
  authorizedRef.current = authorizedSource;

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({ status: 'loading' });
    let tooLarge = false;
    try {
      const attachment = await authorizedRef.current(request.signal);
      if (request.signal.aborted) return;
      const result = await withDownloadedRemoteMediaFile<ReadResult>(
        attachment.url,
        attachment.mimeType || 'application/octet-stream',
        TEXT_ATTACHMENT_PREVIEW_MAX_BYTES,
        async (file) => {
          const text = await file.text();
          return isLikelyBinaryText(text) ? { kind: 'binary' } : { kind: 'text', text };
        },
        request.signal,
        () => { tooLarge = true; },
        { allowEmpty: true },
      );
      if (request.signal.aborted) return;
      if (!result) {
        setState(tooLarge ? { status: 'too-large' } : { status: 'failed' });
        return;
      }
      setState(result.kind === 'binary'
        ? { status: 'binary' }
        : result.text.length === 0 ? { status: 'empty' } : { status: 'ready', text: result.text });
    } catch {
      if (!request.signal.aborted) setState({ status: 'failed' });
    }
  }, [attachmentId]);

  useEffect(() => {
    void load();
    return () => { controller.current?.abort(); };
  }, [load]);

  const message = state.status === 'too-large'
    ? t('groupChat.server.attachmentPreviewTooLarge')
    : state.status === 'binary'
      ? t('groupChat.server.attachmentPreviewBinary')
      : state.status === 'empty'
        ? t('groupChat.server.attachmentPreviewEmpty')
        : t('groupChat.server.attachmentPreviewFailed');
  const openOutside = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({ status: 'loading' });
    try {
      const attachment = await authorizedRef.current(request.signal);
      if (request.signal.aborted) return;
      await openBrowserAsync(attachment.url);
      if (!request.signal.aborted) onClose();
    } catch {
      if (!request.signal.aborted) setState({ status: 'failed' });
    }
  };

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    let uri: string | null = null;
    const request = controller.current;
    try {
      const attachment = await authorizedRef.current(request?.signal);
      if (request?.signal.aborted) return;
      uri = await downloadRemoteMediaShareTemp(
        attachment.url,
        attachment.mimeType ?? "application/octet-stream",
        fileName,
        request?.signal,
      );
      if (!uri) throw new Error("ATTACHMENT_DOWNLOAD_FAILED");
      if (!request?.signal.aborted)
        await Sharing.shareAsync(uri, { mimeType: attachment.mimeType });
    } catch {
      if (!request?.signal.aborted)
        Alert.alert(t("groupChat.server.attachmentFailed"));
    } finally {
      if (uri) {
        try {
          const file = new File(uri);
          if (file.exists) file.delete();
        } catch {
          /* cache reclaimed */
        }
      }
      if (!request?.signal.aborted) setSharing(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.fill, { backgroundColor: colors.surface,
              paddingTop: insets.top + 64,
              paddingBottom: (collection?.names.length ?? 0) > 1 ? 56 : 0,
            }]}>
          <PreviewHeader
            name={fileName}
            onClose={onClose}
            actions={[
              ...(kind === "markdown" || kind === "html" || kind === "diagram"
                ? [
                    {
                      key: "source",
                      label: t(
                        source
                          ? "files.preview.browserShowDocument"
                          : "files.preview.browserShowSource",
                      ),
                      onPress: () => setSource((value) => !value),
                    },
                  ]
                : []),
              {
                key: "share",
                label: t("message.attachmentPreview.share"),
                disabled: sharing,
                onPress: () => {
                  void share();
                },
              },
            ]}
          />
          {state.status === 'loading' ? (
            <View style={styles.messageState} testID="groupChat.server.attachmentPreviewLoading">
              <ActivityIndicator color={colors.textSecondary} />
              <Text style={[textStyles.footnote, { color: colors.textSecondary }]}>{t('groupChat.server.attachmentPreviewLoading')}</Text>
            </View>
          ) : null}
          {state.status === 'failed' || state.status === 'too-large' || state.status === 'binary' || state.status === 'empty' ? (
            <View style={styles.messageState} testID={'groupChat.server.attachmentPreview.' + state.status}>
              <Text style={[textStyles.footnote, styles.stateCopy, { color: colors.textSecondary }]}>{message}</Text>
              {state.status === 'failed' || state.status === 'too-large' ? (
                <Pressable accessibilityRole="button" onPress={() => { void load(); }} style={[styles.action, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} testID="groupChat.server.attachmentPreviewRetry">
                  <Text style={[textStyles.body, { color: colors.textPrimary }]}>{t('groupChat.server.attachmentPreviewRetry')}</Text>
                </Pressable>
              ) : null}
              {!resolveDeviceMedia &&
              kind !== 'html' && (state.status === 'too-large' || state.status === 'binary') ? (
                <Pressable accessibilityRole="button" onPress={() => { void openOutside(); }} style={[styles.action, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} testID="groupChat.server.attachmentPreviewOpenOutside">
                  <ExternalLink color={colors.textPrimary} size={iconSize.md} />
                  <Text style={[textStyles.body, { color: colors.textPrimary }]}>{t('groupChat.server.attachmentPreviewOpenOutside')}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {state.status === 'ready' && !source && kind === "diagram" ? (
            <DiagramDocumentPreview source={state.text} name={fileName} />
          ) : null}
          {state.status === "ready" && !source && kind === 'html' ? (
            <HtmlFileReader html={state.text} javaScriptEnabled={false} testID="groupChat.server.attachmentHtmlPreview" />
          ) : null}
          {state.status === 'ready' && !source && kind === 'markdown' ? (
            <MarkdownFileReader markdown={state.text} imageSources={NO_EXTERNAL_IMAGES} testID="groupChat.server.attachmentMarkdownPreview" />
          ) : null}
          {state.status === 'ready' &&
          (source || kind === "json" || kind === "text") ? (
            <TextDocumentPreview text={state.text} testID={kind === "json" ? "groupChat.server.attachmentJsonPreview" : undefined} />
              ) : null}
              <PreviewFooter />
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLikelyBinaryText(value: string): boolean {
  return /[\x00-\x08\x0B\x0E-\x1F]/.test(value);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  messageState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  stateCopy: { textAlign: 'center' },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingHorizontal: spacing.lg, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
