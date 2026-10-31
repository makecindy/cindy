import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import type { MobileAgentCapabilities } from '@cindy/maker-shared/agent-capabilities';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { CompanionSheet } from './CompanionSheet';
import { ActionInfoRow, SettingsGroup } from './SettingsGroupRows';
import type { RemoteSession } from './types';

/** Snapshot-only inspection: never calls getContextUsage (which can bootstrap an engine). */
export function CompanionContextControl({ session, capabilities, reader, available, running, onRefresh }: {
  session: RemoteSession;
  capabilities: MobileAgentCapabilities | null;
  reader: Pick<MobileMakerTransport, 'input' | 'compactSession'>;
  available: boolean;
  running: boolean;
  onRefresh(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tokens = session.contextTokens;
  const window = session.contextWindow;
  const known = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
    && typeof window === 'number' && Number.isFinite(window) && window > 0;
  const percentage = known ? Math.min(100, Math.max(0, Math.round(tokens / window * 100))) : null;
  const label = percentage === null ? `${t('session.common.context')} —`
    : t('session.menu.contextUsageSummary', { percent: percentage });
  const channel = session.agentKind === 'cc' ? 'claude-input'
    : session.agentKind === 'pi' && !session.remoteHostId && capabilities?.manualCompactSupported
      ? 'compact-session' : null;
  const canCompact = available && !running && !!channel && known && !busy;
  // Confirmation can stay open while the host changes state; recheck current props on acceptance.
  const current = useRef({ canCompact, channel, reader, onRefresh });
  current.current = { canCompact, channel, reader, onRefresh };
  const compact = async () => {
    const request = current.current;
    if (!mounted.current || !request.canCompact || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (request.channel === 'claude-input') {
        await request.reader.input.compact(session.id);
        if (mounted.current) setMessage(t('session.contextControl.requested'));
      } else {
        const result = await request.reader.compactSession(session.id);
        if (mounted.current) setMessage(t(result?.noop ? 'session.contextControl.nothing'
          : result ? 'session.contextControl.success' : 'session.contextControl.requested'));
      }
      if (mounted.current) request.onRefresh();
    } catch (error) {
      if (mounted.current) setMessage(formatRemoteError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const confirm = () => {
    if (!current.current.canCompact) return;
    Alert.alert(t('session.contextControl.compact'), t('session.contextControl.compactHelp'), [
      { text: t('session.common.cancel'), style: 'cancel' },
      { text: t('session.contextControl.compact'), onPress: () => { void compact(); } },
    ]);
  };
  return <View style={styles.entry}>
    <MainWindowActionButton density="compact" action={{ label, onPress: () => setOpen(true), testID: 'companion.context.open' }} />
    <CompanionSheet visible={open} title={t('session.common.context')} onClose={() => setOpen(false)} preventDismiss={busy} testID="companion.context.sheet">
      <View style={styles.body}>
        <Text style={styles.description}>{t('session.contextControl.meaning')}</Text>
        <Text style={styles.value} testID="companion.context.usage">{percentage === null ? '—' : `${percentage}%`}</Text>
        {known ? <Text style={styles.description}>{t('session.contextControl.tokens', {
          used: formatCompactTokens(tokens), total: formatCompactTokens(window),
        })}</Text> : null}
        <Text style={styles.description}>{t(known ? 'session.contextControl.snapshotHint' : 'session.contextControl.unknownHint')}</Text>
        {channel ? <SettingsGroup footer={t('session.contextControl.compactHelp')}
          messages={message ? [{ text: message }] : undefined}>
          <ActionInfoRow accessibilityLabel={t('session.contextControl.compact')}
            label={t(busy ? 'session.contextControl.compacting' : 'session.contextControl.compact')}
            chevron={false} disabled={!canCompact} onPress={confirm} testID="companion.context.compact" />
        </SettingsGroup> : <Text style={styles.description}>{t(session.agentKind === 'codex'
          ? 'session.contextControl.autoHelp' : 'session.common.capabilitiesUnsupported')}</Text>}
      </View>
    </CompanionSheet>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  entry: { alignItems: 'flex-end', paddingHorizontal: spacing.md },
  body: { gap: spacing.md, padding: spacing.lg },
  description: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  value: { fontSize: typeScale.headline, lineHeight: lineHeight.headline, fontWeight: fontWeight.medium, color: colors.textPrimary },
});
