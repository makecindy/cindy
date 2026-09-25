import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react-native';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, radius, spacing, typeScale } from '@/theme/tokens';
import { ChatFilePathContext, type ChatFilePathContextValue } from '@/session/chatFilePathContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { RemotePathStatResult } from '@/device-link/mobileMakerTransport';
import {
  peekRemotePathVerdict,
  peekRemotePathVerdictForRender,
  remotePathVerdictKey,
  subscribeRemotePathVerdictChange,
  verifyRemotePathCached,
} from '@/session/remotePathVerdict';

function ResultFileAction({
  label, absPath, workdir, childSessionId, deviceId,
}: {
  label: string;
  absPath: string;
  workdir: string;
  childSessionId?: string | null;
  deviceId: string;
}) {
  const { openLink, invoke } = useDeviceLink();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [cacheGen, setCacheGen] = useState(0);
  useEffect(() => {
    if (!deviceId || !childSessionId) return;
    const key = remotePathVerdictKey(deviceId, workdir, absPath);
    return subscribeRemotePathVerdictChange((changed) => {
      if (changed === key) setCacheGen((generation) => generation + 1);
    });
  }, [absPath, childSessionId, deviceId, workdir]);
  useEffect(() => {
    if (!deviceId || !childSessionId || peekRemotePathVerdict(deviceId, workdir, absPath)) return;
    void verifyRemotePathCached(deviceId, workdir, absPath, async (path) => {
      await openLink(deviceId);
      return invoke<RemotePathStatResult>(deviceId, 'fs:stat-path', [{ path }]);
    });
  }, [absPath, cacheGen, childSessionId, deviceId, invoke, openLink, workdir]);
  // A lexical path (or an offline/unknown verdict) is not an actionable result.
  // Keep the label readable and selectable until the child file is confirmed.
  const verified = !!childSessionId && !!deviceId
    && peekRemotePathVerdictForRender(deviceId, workdir, absPath) === 'file';
  const icon = <FileText size={iconSize.sm} color={colors.textSecondary} />;
  if (!verified || !childSessionId) return <View style={styles.file}>
    {icon}<Text selectable numberOfLines={1} style={[styles.fileLabel, styles.pending]}>{label}</Text>
  </View>;
  return <Pressable accessibilityRole="link" style={({ pressed }) => [styles.file, pressed && mobileInteractionStyles.pressed]}
    onPress={() => router.push({ pathname: '/files/preview/[sessionId]', params: {
      sessionId: childSessionId, deviceId, absPath,
    } })}>
    {icon}<Text numberOfLines={1} style={[styles.fileLabel, styles.link]}>{label}</Text>
  </Pressable>;
}

/** The delegated task's own files: chips in the result resolve against its directory, not the chat's. */
function useResultFileContext(deviceId: string, childSessionId: string | null | undefined, workdir: string | undefined) {
  const parent = useContext(ChatFilePathContext);
  const { openLink, invoke } = useDeviceLink();
  const router = useRouter();
  return useMemo<ChatFilePathContextValue | null>(() => {
    if (!deviceId || !childSessionId || !workdir) return null;
    return {
      deviceId,
      sessionId: childSessionId,
      workdir,
      statPath: async (absPath: string) => {
        await openLink(deviceId);
        return invoke<RemotePathStatResult>(deviceId, 'fs:stat-path', [{ path: absPath }]);
      },
      onOpenPath: (target) => {
        if (target.kind === 'directory') {
          if (target.relPath === null) return;
          router.push({ pathname: '/files/[sessionId]', params: { sessionId: childSessionId, deviceId, relPath: target.relPath } });
          return;
        }
        router.push({ pathname: '/files/preview/[sessionId]', params: {
          sessionId: childSessionId, deviceId,
          ...(target.relPath !== null ? { relPath: target.relPath } : { absPath: target.absPath }),
          ...(target.line !== undefined ? { line: String(target.line) } : {}),
        } });
      },
      ...(parent?.onLongPressPath ? { onLongPressPath: parent.onLongPressPath } : {}),
    };
  }, [childSessionId, deviceId, invoke, openLink, parent?.onLongPressPath, router, workdir]);
}

/** A frozen execution receipt (Desktop BotSessionTaskResultCard); expanding never restarts or fetches the task. */
export function CompanionTaskResultCard({ meta, deviceId, renderMarkdown }: {
  meta: BotCollaborationMeta;
  deviceId: string;
  /** The conversation's own Markdown renderer, so links, code and file chips read like a reply. */
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showError, setShowError] = useState(false);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const result = meta.result;
  const fileContext = useResultFileContext(deviceId, meta.childSessionId, result?.workingDir ?? undefined);
  if (!result) return null;
  return <View style={styles.card} testID="companion.taskResult">
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
      style={({ pressed }) => [styles.summary, pressed && mobileInteractionStyles.pressed]}>
      <FileText size={iconSize.md} color={colors.textSecondary} />
      <Text numberOfLines={1} style={styles.title}>{meta.objective}</Text>
      <Text numberOfLines={1} style={styles.secondary}>{t(`devices.companions.status.${result.status}`)}</Text>
      <Text numberOfLines={1} style={styles.view}>{t('devices.companions.viewResult')}</Text>
    </Pressable>
    {expanded && <View style={styles.content}>
      {result.text ? renderMarkdown
        ? <ChatFilePathContext.Provider value={fileContext}>{renderMarkdown(result.text)}</ChatFilePathContext.Provider>
        : <Text selectable style={styles.body}>{result.text}</Text>
        : <Text selectable style={styles.body}>{t('devices.companions.noWrittenResult')}</Text>}
      {result.artifacts.map((artifact) => <ResultFileAction key={artifact.absolutePath}
        label={artifact.absolutePath.split(/[\\/]/).pop() ?? artifact.absolutePath}
        absPath={artifact.absolutePath} workdir={result.workingDir ?? ''}
        childSessionId={meta.childSessionId} deviceId={deviceId} />)}
      {result.error ? <View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showError }} onPress={() => setShowError(!showError)}
          style={({ pressed }) => [styles.errorToggle, pressed && mobileInteractionStyles.pressed]}>
          <Text style={styles.secondary}>{t('devices.companions.errorDetails')}</Text>
        </Pressable>
        {showError ? <Text selectable style={styles.secondary}>{result.error}</Text> : null}
      </View> : null}
    </View>}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { marginVertical: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceElevated, borderRadius: radius.container, overflow: 'hidden' },
  summary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { flex: 1, minWidth: 0, fontSize: typeScale.body, color: colors.textPrimary },
  secondary: { flexShrink: 0, fontSize: typeScale.footnote, color: colors.textSecondary },
  view: { flexShrink: 0, fontSize: typeScale.footnote, color: colors.textPrimary },
  body: { fontSize: typeScale.body, color: colors.textPrimary },
  content: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  file: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fileLabel: { flex: 1, minWidth: 0, fontSize: typeScale.body, color: colors.textPrimary },
  pending: { color: colors.textSecondary },
  link: { textDecorationLine: 'underline' },
  errorToggle: { minHeight: 44, justifyContent: 'center' },
});
