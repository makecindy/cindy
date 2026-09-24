import { useEffect, useState } from 'react';
import { Linking, Pressable, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BotCollaborationMeta } from '@cindy/maker-shared/botCollaboration';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';
import { classifyChatPathLinkTarget, isAbsolutePathShape, resolveChatAbsPath } from '@/session/chatPathCandidate';
import { parseMobileMarkdown } from '@/session/messageMarkdown';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { RemotePathStatResult } from '@/device-link/mobileMakerTransport';
import {
  peekRemotePathVerdict,
  peekRemotePathVerdictForRender,
  remotePathVerdictKey,
  subscribeRemotePathVerdictChange,
  verifyRemotePathCached,
} from '@/session/remotePathVerdict';

function resultLinks(text: string): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ label: string; url: string }> = [];
  for (const block of parseMobileMarkdown(text)) {
    if (!('inlines' in block)) continue;
    for (const inline of block.inlines) {
      if (inline.type !== 'link' && inline.type !== 'image') continue;
      if (seen.has(inline.url)) continue;
      seen.add(inline.url);
      links.push({ label: (inline.type === 'image' ? inline.alt : inline.text) || inline.url, url: inline.url });
    }
  }
  return links;
}

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
  if (!verified || !childSessionId) return <View style={styles.action}>
    <Text selectable style={styles.title}>{label}</Text>
  </View>;
  return <Pressable accessibilityRole="link" style={styles.action}
    onPress={() => router.push({ pathname: '/files/preview/[sessionId]', params: {
      sessionId: childSessionId, deviceId, absPath,
    } })}>
    <Text style={[styles.title, styles.link]}>{label}</Text>
  </Pressable>;
}

export function CompanionTaskResultCard({ meta, deviceId }: { meta: BotCollaborationMeta; deviceId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showError, setShowError] = useState(false);
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const result = meta.result;
  if (!result) return null;
  const links = resultLinks(result.text);
  return <View style={styles.card}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.action}>
      <Text numberOfLines={2} style={styles.title}>{meta.objective}</Text>
      <Text style={styles.secondary}>{t(`devices.companions.status.${result.status}`)} · {t('devices.companions.viewResult')}</Text>
    </Pressable>
    {expanded && <View style={styles.content}>
      <Text selectable style={styles.body}>{result.text || t('devices.companions.noWrittenResult')}</Text>
      {links.map(({ label, url }) => {
        if (/^https?:\/\//i.test(url)) return <Pressable key={url} accessibilityRole="link" style={styles.action}
          onPress={() => { void Linking.openURL(url).catch(() => undefined); }}>
          <Text style={[styles.title, styles.link]}>{label}</Text>
        </Pressable>;
        const path = classifyChatPathLinkTarget(url);
        if (!path || (!result.workingDir && !isAbsolutePathShape(path.href) && !path.href.startsWith('file://'))) return null;
        return <ResultFileAction key={url} label={label} absPath={resolveChatAbsPath(path.href, result.workingDir ?? '')}
          workdir={result.workingDir ?? ''} childSessionId={meta.childSessionId} deviceId={deviceId} />;
      })}
      {result.error && <View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showError }} onPress={() => setShowError(!showError)} style={styles.action}>
          <Text style={styles.secondary}>{t('interaction.companion.details')}</Text>
        </Pressable>
        {showError && <Text selectable style={styles.secondary}>{result.error}</Text>}
      </View>}
      {result.artifacts.map((artifact) => <ResultFileAction key={artifact.absolutePath}
        label={artifact.absolutePath.split(/[\\/]/).pop() ?? artifact.absolutePath}
        absPath={artifact.absolutePath} workdir={result.workingDir ?? ''}
        childSessionId={meta.childSessionId} deviceId={deviceId} />)}
    </View>}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.container, overflow: 'hidden' },
  action: { minHeight: 44, padding: spacing.md, gap: spacing.xs },
  title: { fontSize: typeScale.body, color: colors.textPrimary },
  link: { textDecorationLine: 'underline' },
  secondary: { fontSize: typeScale.caption, color: colors.textSecondary },
  body: { fontSize: typeScale.body, color: colors.textPrimary },
  content: { padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
