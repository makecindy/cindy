import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X } from 'lucide-react-native';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { openBrowserAsync } from 'expo-web-browser';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import { extractRemoteFileExt, isHtmlFilePreviewCandidate, remoteFilePreviewKind } from '@cindy/maker-shared/file-preview';
import { Text } from '@/components/AppText';
import { HtmlFileReader } from '@/session/HtmlFileReader';
import { MarkdownFileReader } from '@/session/MarkdownFileReader';
import { withDownloadedRemoteMediaFile } from '@/session/remoteMediaDiskCacheExpo';
import { fontWeight, iconSize, lineHeight, monoFont, radius, spacing, textStyles, typeScale, useTheme } from '@/theme';

const TEXT_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const JSON_ATTACHMENT_PREVIEW_MAX_LINES = 10_000;
const JSON_ATTACHMENT_PREVIEW_MAX_CHARACTERS = 100_000;
const JSON_ATTACHMENT_PREVIEW_MAX_LINE_CHARACTERS = 4_096;
const NO_EXTERNAL_IMAGES: ReadonlyMap<string, { uri: string }> = new Map();

export type BotGroupTextAttachmentPreviewKind = 'html' | 'markdown' | 'json';

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
  if (remoteFilePreviewKind(name) !== 'text') return null;
  if (isHtmlFilePreviewCandidate(name)) return 'html';
  const extension = extractRemoteFileExt(name);
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.json') return 'json';
  return null;
}

export function BotGroupTextAttachmentPreview({ attachmentId, fileName, kind, resolve, onClose }: {
  attachmentId: string;
  fileName: string;
  kind: BotGroupTextAttachmentPreviewKind;
  resolve: ResolveServerMedia;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const controller = useRef<AbortController | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({ status: 'loading' });
    let tooLarge = false;
    try {
      const attachment = await resolveRef.current(attachmentId, request.signal);
      if (request.signal.aborted) return;
      if (attachment.category !== 'file' || !attachment.url || !isCredentialFreeHttpsUrl(attachment.url)) {
        throw new Error('ATTACHMENT_PREVIEW_URL_INVALID');
      }
      const result = await withDownloadedRemoteMediaFile<ReadResult>(
        attachment.url,
        attachment.mimeType || 'application/octet-stream',
        TEXT_ATTACHMENT_PREVIEW_MAX_BYTES,
        async file => {
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

  const jsonPreview = useMemo(
    () => state.status === 'ready' && kind === 'json' ? splitJsonPreviewLines(state.text) : null,
    [kind, state],
  );
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
      const attachment = await resolveRef.current(attachmentId, request.signal);
      if (request.signal.aborted) return;
      if (attachment.category !== 'file' || !attachment.url || !isCredentialFreeHttpsUrl(attachment.url)) {
        throw new Error('ATTACHMENT_PREVIEW_URL_INVALID');
      }
      await openBrowserAsync(attachment.url);
      if (!request.signal.aborted) onClose();
    } catch {
      if (!request.signal.aborted) setState({ status: 'failed' });
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={['top', 'bottom']} style={[styles.fill, { backgroundColor: colors.surface }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('groupChat.server.attachmentPreviewClose')}
              onPress={onClose}
              style={styles.closeButton}
              testID="groupChat.server.attachmentPreviewCloseButton"
            >
              <X color={colors.textSecondary} size={iconSize.action} />
            </Pressable>
            <Text numberOfLines={1} style={[textStyles.body, styles.title, { color: colors.textPrimary }]}>{fileName}</Text>
          </View>
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
              {kind !== 'html' && (state.status === 'too-large' || state.status === 'binary') ? (
                <Pressable accessibilityRole="button" onPress={() => { void openOutside(); }} style={[styles.action, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]} testID="groupChat.server.attachmentPreviewOpenOutside">
                  <ExternalLink color={colors.textPrimary} size={iconSize.md} />
                  <Text style={[textStyles.body, { color: colors.textPrimary }]}>{t('groupChat.server.attachmentPreviewOpenOutside')}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {state.status === 'ready' && kind === 'html' ? (
            <HtmlFileReader html={state.text} javaScriptEnabled={false} testID="groupChat.server.attachmentHtmlPreview" />
          ) : null}
          {state.status === 'ready' && kind === 'markdown' ? (
            <MarkdownFileReader markdown={state.text} imageSources={NO_EXTERNAL_IMAGES} testID="groupChat.server.attachmentMarkdownPreview" />
          ) : null}
          {state.status === 'ready' && kind === 'json' ? (
            <View style={styles.fill}>
              {jsonPreview?.truncated ? (
                <Text style={[textStyles.footnote, styles.truncated, { color: colors.textSecondary }]}>{t('groupChat.server.attachmentPreviewTruncated')}</Text>
              ) : null}
              <FlatList
                data={jsonPreview?.lines ?? []}
                keyExtractor={(_, index) => String(index)}
                renderItem={({ item, index }) => (
                  <View style={styles.codeRow}>
                    <Text selectable={false} style={[textStyles.caption, styles.lineNumber, { color: colors.textTertiary }]}>{index + 1}</Text>
                    <Text selectable style={[styles.codeText, { color: colors.textPrimary }]}>{item || ' '}</Text>
                  </View>
                )}
                style={styles.fill}
                contentContainerStyle={styles.codeList}
                testID="groupChat.server.attachmentJsonPreview"
              />
            </View>
          ) : null}
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

function splitJsonPreviewLines(text: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let start = 0;
  let characters = 0;
  while (lines.length < JSON_ATTACHMENT_PREVIEW_MAX_LINES && characters < JSON_ATTACHMENT_PREVIEW_MAX_CHARACTERS) {
    const end = text.indexOf('\n', start);
    const lineEnd = end < 0 ? text.length : end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = text.slice(start, lineEnd);
    const visible = line.slice(0, Math.min(JSON_ATTACHMENT_PREVIEW_MAX_LINE_CHARACTERS, JSON_ATTACHMENT_PREVIEW_MAX_CHARACTERS - characters));
    lines.push(visible);
    characters += visible.length;
    start = end < 0 ? text.length : end + 1;
    if (visible.length < line.length) return { lines, truncated: true };
    if (end < 0) return { lines, truncated: false };
  }
  return { lines, truncated: start < text.length };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, fontWeight: fontWeight.semibold },
  messageState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  stateCopy: { textAlign: 'center' },
  truncated: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingHorizontal: spacing.lg, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  codeList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  codeRow: { flexDirection: 'row', alignItems: 'flex-start' },
  lineNumber: { width: 40, paddingRight: spacing.sm, textAlign: 'right' },
  codeText: { flex: 1, minWidth: 0, fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
});
