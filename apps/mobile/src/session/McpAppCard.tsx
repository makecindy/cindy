import { mcpAppInitialHeight, parseMcpAppSource, parseMcpAppCustomMcp, isExceptionalPluginSource } from '@cindy/maker-shared/mcp-apps';
import { MCP_APP_MAX_HEIGHT } from '@cindy/maker-shared/mcp-app-controller';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Dimensions, Keyboard, Pressable, StyleSheet, View, type ViewInstance } from 'react-native';
import { MessageListRevealContext, MessageListKeepKeyboardContext } from './messageListReveal';
import { MessageListItemViewableContext, MessageListVisibilityContext } from './messageListVisibility';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useTheme, textStyles, fontWeight, radius, spacing } from '@/theme';
import { useMcpAppViews, NativeMcpAppSlot, mcpAppSurfaceAvailable } from './McpAppViews';
import type { McpAppView, McpAppViewState } from './mcpAppView';
import { MCP_APP_DEFAULT_HEIGHT } from './mcpAppView';
import { getLoadedMobileHeights, getMobileHeights, subscribeMobileHeights } from './mcpAppMeasuredHeights';

interface McpAppCardProps {
  initialHeight?: unknown;
  plugin?: unknown; customMcp?: unknown;
  deviceId?: string; sessionId: string; clientId: string; title: string; active?: boolean; fallbackText?: string;
}
function McpAppIdentity({ title, plugin, customMcp }: Pick<McpAppCardProps, 'title' | 'plugin' | 'customMcp'>) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const identity = plugin && typeof plugin === 'object' ? plugin as { name?: string; source?: unknown } : undefined;
  const origin = identity?.source === undefined ? undefined : parseMcpAppSource(identity.source);
  const custom = parseMcpAppCustomMcp(customMcp);
  const label = origin && isExceptionalPluginSource(origin) ? t(`mcpApps.source.${origin.kind}`) : custom ? t('mcpApps.customMcp') : undefined;
  return <><Text style={[styles.title, { color: colors.textPrimary }]}>{identity?.name || (custom && custom !== true ? custom.name : title) || t('mcpApps.appName')}</Text>
    {label && <Text style={[styles.source, { color: custom ? colors.textSecondary : colors.warningFg }]}>{label}</Text>}</>;
}

export function McpAppCard(props: McpAppCardProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (isSharedTaskPeer(props.deviceId)) return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <McpAppIdentity {...props} />
      </View>
      {props.fallbackText ? <Text selectable style={[styles.historyText, { color: colors.textPrimary }]}>{props.fallbackText}</Text> : null}
      <Text style={[styles.error, { color: colors.textSecondary }]}>{t('mcpApps.sharedTaskReadOnly')}</Text>
    </View>
  );
  return <MeasuredMcpAppCard {...props} />;
}

function MeasuredMcpAppCard(props: McpAppCardProps) {
  // The cache hydrates asynchronously. Keep the normal 320/declared placeholder
  // visible while it loads, then reuse the hydrated value on the next open.
  useSyncExternalStore(subscribeMobileHeights, getLoadedMobileHeights);
  return <InteractiveMcpAppCard {...props} />;
}

function InteractiveMcpAppCard({ deviceId, sessionId, clientId, title, active = true, fallbackText, plugin, customMcp, initialHeight }: McpAppCardProps) {
  const host = useMcpAppViews();
  const { colors, mode } = useTheme();
  const { t, i18n } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<McpAppView>();
  const declaredHeight = mcpAppInitialHeight(initialHeight) ?? MCP_APP_DEFAULT_HEIGHT;
  const [state, setState] = useState<McpAppViewState>({ loading: true, height: declaredHeight });
  const foreground = host?.foreground ?? false;
  // Keyboard resizing can temporarily remove the row from the visible set.
  // Its focused document must survive that transition, including unsaved input.
  const list = useContext(MessageListVisibilityContext);
  const rowVisible = useContext(MessageListItemViewableContext);
  const card = useRef<ViewInstance>(null);
  const [watchQuota, setWatchQuota] = useState(false);
  const [quotaOffscreen, setQuotaOffscreen] = useState(false);
  const checkQuota = useRef<() => boolean>(() => true);
  checkQuota.current = () => {
    const bounds = card.current?.getBoundingClientRect?.();
    const viewport = list?.viewport?.();
    const visible = active && rowVisible !== false && (!list || !bounds || (bounds.height > 0 &&
      bounds.bottom > (viewport?.top ?? 0) && bounds.top < (viewport?.bottom ?? Dimensions.get('window').height)));
    setQuotaOffscreen(!visible);
    return visible;
  };
  useLayoutEffect(() => {
    if (!watchQuota) return;
    checkQuota.current();
    return list?.onViewportChange(() => { checkQuota.current(); });
  }, [watchQuota, list, active, rowVisible]);
  useEffect(() => {
    if (view?.document) setWatchQuota(false);
  }, [view?.document]);
  const surfaceActive = (active || !!state.focus) && !quotaOffscreen;
  const width = useRef(0);
  const frame = useRef<ViewInstance>(null);
  const reveal = useContext(MessageListRevealContext);
  const keepKeyboard = useContext(MessageListKeepKeyboardContext);
  const revealFocus = useRef(() => {});
  revealFocus.current = () => {
    const rect = state.focus;
    if (!rect || !reveal || !foreground || view?.closing) return;
    frame.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y)) reveal({ top: y + rect.top, bottom: y + rect.bottom });
    });
  };
  useEffect(() => {
    if (!state.focus || !foreground || view?.closing) return;
    return keepKeyboard?.();
  }, [!!state.focus, foreground, view?.closing, keepKeyboard]);
  useEffect(() => {
    let frameId: number | undefined;
    const schedule = () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => revealFocus.current());
    };
    schedule();
    const subscriptions = ['keyboardDidShow', 'keyboardDidChangeFrame'].map(name =>
      Keyboard.addListener(name as 'keyboardDidShow', schedule));
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [state.focus, foreground]);
  const context = useMemo(() => ({
    platform: 'mobile', theme: mode, locale: i18n.resolvedLanguage ?? i18n.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    deviceCapabilities: { touch: true, hover: false }, containerDimensions: { maxHeight: MCP_APP_MAX_HEIGHT },
    styles: { variables: {
      '--color-background-primary': colors.surface, '--color-background-secondary': colors.surfaceElevated,
      '--color-text-primary': colors.textPrimary, '--color-text-secondary': colors.textSecondary,
      '--color-text-tertiary': colors.textTertiary, '--color-border-primary': colors.border, '--font-sans': 'system-ui, sans-serif',
    } },
  }), [mode, colors, i18n.resolvedLanguage, i18n.language]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const isPlugin = !!plugin;
  const open = host?.open;
  const hasHost = !!host;
  useEffect(() => {
    const measuredWidth = frame.current?.getBoundingClientRect?.().width ?? width.current;
    setView(undefined);
    if (!surfaceActive || (hasHost && !foreground)) {
      const remembered = deviceId ? getMobileHeights().get(JSON.stringify([deviceId, sessionId, clientId]), measuredWidth) : undefined;
      // Keep a compact waiting row while it is offscreen so it cannot manufacture
      // a new intersection by expanding into a full error placeholder.
      setState((previous) => ({ ...previous, height: remembered ?? previous.height ?? declaredHeight, loading: false,
        error: quotaOffscreen ? 'mcpApps.viewLimit' : undefined }));
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
    const current = open(deviceId, sessionId, clientId, contextRef.current, isPlugin, () => {
      setWatchQuota(true);
      return checkQuota.current();
    }, declaredHeight);
    current.setWidth(measuredWidth);
    setView(current);
    const unsubscribe = current.subscribe(setState);
    return () => {
      unsubscribe();
      // The persistent host owns the live WebView, including after this actual
      // card/route unmount. Its close() removes that same View only at the bound.
      void current.close();
    };
  }, [open, hasHost, foreground, deviceId, sessionId, clientId, attempt, surfaceActive, quotaOffscreen, isPlugin, declaredHeight]);
  useEffect(() => { if (!view?.closing) void view?.controller.context(context).catch(() => {}); }, [view, context]);
  const { error, loading, height, filesUnavailable } = state;
  return (
    <View ref={card} collapsable={false} onLayout={() => { if (watchQuota) checkQuota.current(); }} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <McpAppIdentity title={title} plugin={plugin} customMcp={customMcp} />
        {surfaceActive && loading && <ActivityIndicator size="small" color={colors.textSecondary} />}
        {error && <Pressable accessibilityRole="button" onPress={() => setAttempt((value) => value + 1)} style={styles.retry}>
          <Text style={[styles.action, { color: colors.textPrimary }]}>{t('mcpApps.retry')}</Text>
        </Pressable>}
      </View>
      {error && <Text style={[styles.error, { color: colors.textSecondary }]}>{t(error)}</Text>}
      {filesUnavailable && <Text style={[styles.error, { color: colors.textSecondary }]}>{t('mcpApps.filesOnExecutionComputer')}</Text>}
      {(error || filesUnavailable) && fallbackText ? <Text selectable style={[styles.historyText, { color: colors.textPrimary }]}>{fallbackText}</Text> : null}
      {!error && !filesUnavailable && <View ref={frame} collapsable={false} style={{ height }} onLayout={(event) => {
        width.current = event.nativeEvent.layout.width; view?.setWidth(width.current);
        revealFocus.current();
      }}>
        {surfaceActive && foreground && view && NativeMcpAppSlot ? <NativeMcpAppSlot surfaceId={view.id} style={{ flex: 1 }} /> : null}
      </View>}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden', marginVertical: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  title: { ...textStyles.subtitle, fontWeight: fontWeight.medium, flex: 1 },
  source: { ...textStyles.caption },
  action: { ...textStyles.body, fontWeight: fontWeight.medium },
  error: { ...textStyles.footnote, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  historyText: { ...textStyles.bodyLarge, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  retry: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
