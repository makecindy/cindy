import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CircleAlert, CircleCheck, FileText } from 'lucide-react-native';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import type { BotDelegationListResult } from '@cindy/maker-shared/botDelegation';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { motionDuration, motionEasing, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { parseMobileMarkdownInlines } from './messageMarkdown';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { ChatFilePathContext, type ChatFilePathContextValue, type ChatFilePathTarget } from '@/session/chatFilePathContext';
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
  const push = useGuardedPush();
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
    onPress={() => push({ pathname: '/files/preview/[sessionId]', params: {
      sessionId: childSessionId, deviceId, absPath,
    } })}>
    {icon}<Text numberOfLines={1} style={[styles.fileLabel, styles.link]}>{label}</Text>
  </Pressable>;
}

/** The delegated task's own files: chips in the result resolve against its directory, not the chat's. */
function useResultFileContext(deviceId: string, childSessionId: string | null | undefined, workdir: string | undefined) {
  const parent = useContext(ChatFilePathContext);
  const { openLink, invoke } = useDeviceLink();
  const push = useGuardedPush();
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
          push({ pathname: '/files/[sessionId]', params: { sessionId: childSessionId, deviceId, relPath: target.relPath } });
          return;
        }
        push({ pathname: '/files/preview/[sessionId]', params: {
          sessionId: childSessionId, deviceId,
          ...(target.relPath !== null ? { relPath: target.relPath } : { absPath: target.absPath }),
          ...(target.line !== undefined ? { line: String(target.line) } : {}),
        } });
      },
      // The chat's action menu runs against the child task, not the conversation holding the card.
      ...(parent?.onLongPressPath ? {
        onLongPressPath: (target: ChatFilePathTarget) => parent.onLongPressPath?.({ ...target, scope: { sessionId: childSessionId, workdir } }),
      } : {}),
    };
  }, [childSessionId, deviceId, invoke, openLink, parent, push, workdir]);
}

/** Frozen result data; legacy receipts may read the existing task title only. */
export function CompanionTaskResultCard({ meta, deviceId, parentSessionId, renderMarkdown, attached = false }: {
  meta: BotCollaborationMeta;
  attached?: boolean;
  deviceId: string;
  parentSessionId?: string;
  /** The conversation's own Markdown renderer, so links, code and file chips read like a reply. */
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showError, setShowError] = useState(false);
  const animate = useReduceMotionEnabled() === false;
  const turn = useRef(new Animated.Value(0)).current;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const result = meta.result;
  const fileContext = useResultFileContext(deviceId, meta.childSessionId, result?.workingDir ?? undefined);
  const { value } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId,
    'maker:bot-delegations:list', [parentSessionId ?? meta.parentSessionId],
    { enabled: Boolean(result && !result.title?.trim() && (parentSessionId ?? meta.parentSessionId)) });
  const row = value?.ok && Array.isArray(value.delegations)
    ? value.delegations.find((item) => item.id === meta.delegationId) : undefined;
  if (!result) return null;
  const title = result.title?.trim() || row?.title?.trim() || meta.objective.trim().split('\n')[0] || t('devices.companions.backgroundTask');
  const preview = result.text ? parseMobileMarkdownInlines(result.text).map((inline) => inline.type === 'image' ? inline.alt : inline.text)
    .join('').replace(/\s+/g, ' ').trim() : '';
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (animate) Animated.timing(turn, { toValue: next ? 1 : 0, duration: motionDuration.base, easing: Easing.bezier(...motionEasing.move), useNativeDriver: true }).start();
    else turn.setValue(next ? 1 : 0);
  };
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  return <View style={[styles.card, attached && styles.attached]} testID="companion.taskResult">
    {/* K6: the whole card opens and closes the result; no separate 「查看结果」 button. */}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${t('devices.companions.taskResult')}, ${title}`}
      accessibilityHint={t(expanded ? 'devices.companions.collapseResult' : 'devices.companions.viewResult')}
      onPress={toggle} style={({ pressed }) => [styles.head, pressed && mobileInteractionStyles.pressed]} testID="companion.taskResult.toggle">
      <View style={styles.eyebrow}>
        <FileText size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
        <Text style={styles.eyebrowText}>{t('devices.companions.taskResult')}</Text>
        <Animated.View style={[styles.chevron, { transform: [{ rotate }] }]}>
          <ChevronDown size={iconSize.md} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
        </Animated.View>
      </View>
      <Text numberOfLines={2} style={styles.title}>{title}</Text>
      <View style={styles.meta}>
        {result.status === 'completed'
          ? <CircleCheck size={iconSize.xs} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
          : result.status === 'cancelled' ? null : <CircleAlert size={iconSize.xs} color={colors.statusError} strokeWidth={iconStroke.regular} />}
        <Text style={styles.metaText}>{t(`devices.companions.status.${result.status}`)}</Text>
      </View>
      {!expanded && preview ? <Text numberOfLines={3} style={styles.preview}>{preview}</Text> : null}
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
  // K1 card shell: raised surface, hairline border, radius 12, padding 16.
  card: { marginVertical: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceElevated, borderRadius: radius.container, padding: spacing.lg },
  // Hung under the teammate's final reply (the result belongs to that answer): full column width, no outer gap.
  attached: { width: '100%', maxWidth: 440, alignSelf: 'flex-start', marginVertical: 0, padding: spacing.md },
  head: { gap: spacing.xs },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, minHeight: lineHeight.caption },
  eyebrowText: { flex: 1, minWidth: 0, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium, color: colors.textSecondary },
  chevron: { flexShrink: 0 },
  title: { marginTop: 2, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  metaText: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  preview: { marginTop: spacing.xs, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, color: colors.textPrimary },
  secondary: { flexShrink: 0, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary },
  content: { marginTop: spacing.md, paddingTop: spacing.md, gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  file: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fileLabel: { flex: 1, minWidth: 0, fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary },
  pending: { color: colors.textSecondary },
  link: { textDecorationLine: 'underline' },
  errorToggle: { minHeight: 44, justifyContent: 'center' },
});
