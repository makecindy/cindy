import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useTheme, textStyles, fontWeight, radius, spacing } from '@/theme';
import { useMcpAppViews, NativeMcpAppSlot, mcpAppSurfaceAvailable } from './McpAppViews';
import type { McpAppView, McpAppViewState } from './mcpAppView';

interface McpAppCardProps {
  deviceId?: string; sessionId: string; clientId: string; title: string; active?: boolean; fallbackText?: string;
}
export function McpAppCard(props: McpAppCardProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (isSharedTaskPeer(props.deviceId)) return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {props.title ? t('mcpApps.cardTitle', { title: props.title }) : t('mcpApps.appName')}
        </Text>
      </View>
      {props.fallbackText ? <Text selectable style={[styles.historyText, { color: colors.textPrimary }]}>{props.fallbackText}</Text> : null}
      <Text style={[styles.error, { color: colors.textSecondary }]}>{t('mcpApps.sharedTaskReadOnly')}</Text>
    </View>
  );
  return <InteractiveMcpAppCard {...props} />;
}

function InteractiveMcpAppCard({ deviceId, sessionId, clientId, title, active = true, fallbackText }: McpAppCardProps) {
  const host = useMcpAppViews();
  const { colors, mode } = useTheme();
  const { t, i18n } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<McpAppView>();
  const [state, setState] = useState<McpAppViewState>({ loading: true, height: 320 });
  const width = useRef(1);
  const context = useMemo(() => ({
    platform: 'mobile', theme: mode, locale: i18n.resolvedLanguage ?? i18n.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    deviceCapabilities: { touch: true, hover: false }, containerDimensions: { maxHeight: 1_200 },
    styles: { variables: {
      '--color-background-primary': colors.surface, '--color-background-secondary': colors.surfaceElevated,
      '--color-text-primary': colors.textPrimary, '--color-text-secondary': colors.textSecondary,
      '--color-text-tertiary': colors.textTertiary, '--color-border-primary': colors.border, '--font-sans': 'system-ui, sans-serif',
    } },
  }), [mode, colors, i18n.resolvedLanguage, i18n.language]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const foreground = host?.foreground ?? false;
  const open = host?.open;
  const hasHost = !!host;
  useEffect(() => {
    setView(undefined);
    if (!active || (hasHost && !foreground)) {
      setState((previous) => ({ height: previous.height, loading: false }));
      return;
    }
    if (!mcpAppSurfaceAvailable || !open) {
      setState((previous) => ({ ...previous, loading: false, error: 'mcpApps.mobileUpdateRequired' }));
      return;
    }
    if (!deviceId) {
      setState((previous) => ({ ...previous, loading: false, error: 'mcpApps.loadFailed' }));
      return;
    }
    const current = open(deviceId, sessionId, clientId, contextRef.current);
    current.setWidth(width.current);
    setView(current);
    const unsubscribe = current.subscribe(setState);
    return () => {
      unsubscribe();
      // The persistent host owns the live WebView, including after this actual
      // card/route unmount. Its close() removes that same View only at the bound.
      void current.close();
    };
  }, [open, hasHost, foreground, deviceId, sessionId, clientId, attempt, active]);
  useEffect(() => { if (!view?.closing) void view?.controller.context(context).catch(() => {}); }, [view, context]);
  const { error, loading, height } = state;
  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title ? t('mcpApps.cardTitle', { title }) : t('mcpApps.appName')}</Text>
        {active && loading && <ActivityIndicator size="small" color={colors.textSecondary} />}
        {error && <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={styles.retry}>
          <Text style={[styles.action, { color: colors.textPrimary }]}>{t('mcpApps.retry')}</Text>
        </Pressable>}
      </View>
      {error && <Text style={[styles.error, { color: colors.textSecondary }]}>{t(error)}</Text>}
      {error && fallbackText ? <Text selectable style={[styles.historyText, { color: colors.textPrimary }]}>{fallbackText}</Text> : null}
      {!error && <View style={{ height }} onLayout={(event) => {
        width.current = event.nativeEvent.layout.width; view?.setWidth(width.current);
      }}>
        {active && foreground && view && NativeMcpAppSlot ? <NativeMcpAppSlot surfaceId={view.id} style={{ flex: 1 }} /> : null}
      </View>}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden', marginVertical: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { ...textStyles.subtitle, fontWeight: fontWeight.medium, flex: 1 },
  action: { ...textStyles.body, fontWeight: fontWeight.medium },
  error: { ...textStyles.footnote, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  historyText: { ...textStyles.bodyLarge, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  retry: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
