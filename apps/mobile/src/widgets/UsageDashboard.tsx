import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { MobileUsageWidgetSnapshot as Snapshot } from '@cindy/maker-shared/device-link-contract';
import { UsageQuotaColumns } from './UsageQuotaColumns';
import { CountUp, useOpeningMotion } from './usageOpeningMotion';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { automaticUsageState, readUsageWidgetStore, subscribeUsageWidgetStore } from './usageWidgetSync';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

export function useAutomaticUsage() {
  const { user, isAuthenticated } = useAuth();
  const store = useSyncExternalStore(subscribeUsageWidgetStore, readUsageWidgetStore, () => null);
  return automaticUsageState(store, isAuthenticated ? user?.id : undefined);
}

/** Like the widgets: readings an hour old are shown as old, whatever the computer last reported. */
const STALE_AFTER_MS = 3_600_000;
function useStaleNotice(snapshot: Snapshot | null) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const updated = snapshot ? snapshot.updatedAtMs ?? snapshot.generatedAtMs : null;
  useEffect(() => {
    if (updated == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [updated]);
  if (!snapshot || updated == null || now - updated < STALE_AFTER_MS) return null;
  const hours = Math.floor((now - updated) / 3_600_000);
  const template = hours < 24 ? snapshot.strings.updatedHours : snapshot.strings.updatedDays;
  return template?.replace('{{n}}', String(hours < 24 ? hours : Math.floor(hours / 24)))
    ?? t('session.menu.usage.lastUpdated', { time: new Date(updated).toLocaleString(i18n.language) });
}

function usageDayLabel(snapshot: Snapshot, today: string) {
  const lastDay = snapshot.usage.days.at(-1);
  const now = new Date();
  const localDay = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return lastDay && lastDay !== localDay ? lastDay : snapshot.strings.today ?? today;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function compact(value: number, locale: string) {
  const unit = [{ size: 1e9, label: 'B' }, { size: 1e6, label: 'M' }, { size: 1e3, label: 'K' }]
    .find(item => value >= item.size);
  return unit ? (value / unit.size).toLocaleString(locale, { maximumFractionDigits: 1 }) + unit.label
    : value.toLocaleString(locale);
}

// Match the widget: accept model buckets only when the complete period has the
// expected layout. Earlier desktops expose three harness buckets instead.
function chartBuckets(usage: Snapshot['usage'], colors: ThemeColors, other: string) {
  const models = usage.models;
  if (models?.length && usage.daily.every(day =>
    day.models?.length === models.length + 1 && day.modelTokens?.length === models.length + 1)) {
    const palette = [colors.taskTagTeal, colors.taskTagPink, colors.taskTagPurple, colors.taskTagIndigo, colors.taskTagOrange];
    return [...models.map((model, index) => ({ label: model.name, color: palette[index % palette.length]!, index, rest: false })),
      { label: other, color: colors.taskTagGray, index: models.length, rest: true }]
      .map(bucket => ({ ...bucket, value: (day: Snapshot['usage']['daily'][number]) => day.modelTokens![bucket.index]! }));
  }
  return [{ label: 'Codex', color: colors.taskTagBlue, index: 1 },
    { label: 'Claude Code', color: colors.taskTagCoral, index: 0 },
    { label: 'Pi', color: colors.taskTagTeal, index: 2 }].map(bucket => ({
    ...bucket, rest: false, value: (day: Snapshot['usage']['daily'][number]) => day.tokens[bucket.index]!,
  }));
}

/**
 * The one grouping behind both the bars and the share list, in stacking order. With more
 * than four non-empty buckets, the three largest models stay and everything else is "Other".
 */
function usageSeries(usage: Snapshot['usage'], colors: ThemeColors, other: string) {
  const buckets = chartBuckets(usage, colors, other).map(bucket => ({ ...bucket,
    tokens: usage.daily.reduce((total, day) => total + bucket.value(day), 0) })).filter(bucket => bucket.tokens > 0);
  if (buckets.length <= 4) return buckets;
  const kept = new Set(buckets.filter(bucket => !bucket.rest).sort((a, b) => b.tokens - a.tokens).slice(0, 3));
  const merged = buckets.filter(bucket => !kept.has(bucket));
  return [...buckets.filter(bucket => kept.has(bucket)), { label: other, color: colors.taskTagGray, index: -1, rest: true,
    tokens: sum(merged.map(bucket => bucket.tokens)),
    value: (day: Snapshot['usage']['daily'][number]) => sum(merged.map(bucket => bucket.value(day))) }];
}

function HistoryBars({ snapshot, small = false }: { snapshot: Snapshot; small?: boolean }) {
  const { colors } = useTheme();
  const days = snapshot.usage.daily.slice(-30);
  const max = Math.max(1, ...days.map(day => sum(day.tokens)));
  const { t } = useTranslation();
  const series = usageSeries(snapshot.usage, colors, t('devices.usageOther'));
  const height = small ? 28 : 108;
  const average = days.length ? days.reduce((total, day) => total + sum(day.tokens), 0) / days.length : 0;
  return <View style={{ flexDirection: 'row', gap: small ? 2 : 3, height, alignItems: 'flex-end' }}>
    {days.map((day, index) => <View key={index} style={{ flex: 1, height: height * sum(day.tokens) / max,
      borderTopLeftRadius: 2, borderTopRightRadius: 2, overflow: 'hidden', flexDirection: 'column-reverse' }}>
      {series.map((item, key) => item.value(day) > 0 && <View key={key} style={{ flex: item.value(day), backgroundColor: item.color }} />)}
    </View>)}
    {!small && average > 0 && <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0,
      bottom: height * average / max, borderTopWidth: 1, borderStyle: 'dashed', borderColor: colors.textTertiary }} />}
  </View>;
}

function TokenScope({ scope, name }: { scope: Snapshot['usage']['scope']; name?: string }) {
  const { t } = useTranslation();
  const s = useThemedStyles(styles);
  if (scope === 'local' && !name) return null;
  return <Text style={[s.meta, s.scope]} numberOfLines={1}>
    {scope === 'local' ? t('devices.usageOnlyDevice', { name }) : t('devices.presentation.home.allComputers')}
  </Text>;
}

export function DrawerUsage({ onOpen }: { onOpen(): void }) {
  const state = useAutomaticUsage();
  const snapshot = state?.kind === 'snapshot' ? state.snapshot : null;
  const { t, i18n } = useTranslation();
  const s = useThemedStyles(styles);
  const { colors } = useTheme();
  const accounts = snapshot?.sources.filter(source => source.kind === 'subscription') ?? [];
  const preview = accounts.slice(0, 4);
  const day = snapshot?.usage.daily.at(-1);
  const staleNotice = useStaleNotice(snapshot);
  // The drawer mounts this card each time it opens, so every opening plays once.
  const opening = useOpeningMotion();
  return <Pressable accessibilityRole="button" onPress={onOpen} testID="home.chromeDrawer.usage"
    style={({ pressed }) => [s.drawer, pressed && { backgroundColor: colors.surfaceChip }]}>
    <View style={s.between}><Text style={s.section}>{t('devices.usageTitle')}</Text>
      <ChevronRight size={iconSize.md} color={colors.textSecondary} /></View>
    {snapshot && preview.length > 0 ? <View style={s.compactPlans}>
      <View style={s.between}><Text style={s.meta}>{t('devices.usagePlans')}</Text>
        <View style={s.legendItem}>
          {staleNotice && <Text style={s.stale} numberOfLines={1}>{staleNotice}</Text>}
          {accounts.length > preview.length && <Text style={s.meta}>+{accounts.length - preview.length}</Text>}
        </View></View>
      <UsageQuotaColumns sources={preview} strings={snapshot.strings} compact stale={!!staleNotice} palette="panel"
        opening={opening} locale={snapshot.locale} />
    </View> : null}
    {day && state?.kind === 'snapshot' ? <View style={preview.length > 0 ? s.usageDivider : undefined}>
      <View style={s.between}>
        <Text style={s.meta}>{usageDayLabel(state.snapshot, t('session.menu.usage.today'))} · {t('session.menu.usage.tokenUnit')}</Text>
        <TokenScope scope={state.snapshot.usage.scope} name={state.deviceName} />
      </View>
      <View style={s.usageStrip}>
        <Text style={s.number}><CountUp text={compact(sum(day.tokens), i18n.language)} locale={i18n.language} delay={0.2} play={opening} /></Text>
        <View style={s.spark}><HistoryBars snapshot={state.snapshot} small /></View>
      </View>
    </View> : null}
    {!snapshot ? <Text style={s.meta}>{t('session.menu.usage.quotaUnavailable')}</Text> : null}
  </Pressable>;
}

export function UsageDashboard({ snapshot, name }: { snapshot: Snapshot; name?: string }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const s = useThemedStyles(styles);
  const { user } = useAuth();
  const { sources, usage, strings } = snapshot;
  const day = usage.daily.at(-1);
  const money = (amount: number) => snapshot.moneySymbol + amount.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const grouped = usageSeries(usage, colors, t('devices.usageOther'));
  // Largest first; a merged "Other" always closes the list.
  const series = [...grouped].sort((a, b) => (a.index < 0 ? 1 : b.index < 0 ? -1 : b.tokens - a.tokens));
  const staleNotice = useStaleNotice(snapshot);
  const periodTotal = usage.daily.reduce((total, day) => total + sum(day.tokens), 0);
  const accounts = sources.filter(source => source.kind === 'subscription');
  return <View style={{ gap: spacing.lg }}>
    {name ? <Text style={s.section}>{name}</Text> : null}
      {accounts.length > 0 && <View style={s.card}>
        <View style={s.between}><Text style={s.section}>{t('devices.usagePlans')}</Text>
          {staleNotice && <Text style={s.stale} numberOfLines={1}>{staleNotice}</Text>}</View>
        <UsageQuotaColumns sources={accounts} strings={strings} stale={!!staleNotice} />
      </View>}
    <View style={s.card}>
      <View style={s.between}><Text style={s.section}>{usageDayLabel(snapshot, t('session.menu.usage.today'))}</Text>
        <TokenScope scope={usage.scope} name={name} /></View>
      {day ? <>
        <View><Text style={s.hero}>{compact(sum(day.tokens), i18n.language)} <Text style={s.meta}>{t('session.menu.usage.tokenUnit')}</Text></Text>
          <Text style={s.meta}>{t('session.menu.usage.estimatedValue')} {money(sum(day.money))} · {t('session.menu.usage.actualCost')} {money(day.paid)}</Text></View>
        <View>{strings.dailyAverage && <Text style={[s.meta, { textAlign: 'right', marginBottom: spacing.sm }]}>
          {strings.dailyAverage} {compact(periodTotal / usage.daily.length, i18n.language)} {t('session.menu.usage.tokenUnit')}</Text>}
          <HistoryBars snapshot={snapshot} />
          <View style={s.between}><Text style={s.meta}>{usage.days.at(-Math.min(30, usage.days.length))}</Text><Text style={s.meta}>{usage.days.at(-1)}</Text></View></View>
        <View style={s.breakdown}>
          <View style={s.between}><Text style={s.section}>{t('session.menu.usage.totalTokens')}</Text>
            <Text style={s.section}>{compact(periodTotal, i18n.language)}</Text></View>
          {series.map((item, index) => <View key={index} style={s.between}>
            <View style={s.legendItem}><View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: item.color }} />
              <Text style={s.meta}>{item.label}</Text></View>
            <Text style={s.meta}>{Math.round(item.tokens / periodTotal * 100)}% · {compact(item.tokens, i18n.language)}</Text>
          </View>)}
        </View>
      </> : <Text style={s.meta}>{t('session.menu.usage.unavailable')}</Text>}
    </View>
    {sources.filter(source => source.kind === 'balance' && (source.value != null || source.label != null)).map(source => (
      <View style={s.between} key={source.id}>
        <Text style={s.meta}>{user?.membershipKind === 'org' ? t('devices.usageBudget') : source.detail?.title || source.name}</Text>
        <Text style={s.meta}>{source.value ?? source.label}</Text>
      </View>
    ))}
    {snapshot.updatedAtMs != null && <Text style={s.meta}>{t('session.menu.usage.lastUpdated', { time: new Date(snapshot.updatedAtMs).toLocaleString(i18n.language) })}</Text>}
  </View>;
}

const styles = (c: ThemeColors) => StyleSheet.create({
  card: { backgroundColor: c.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderTranslucent, borderRadius: radius.container, padding: spacing.xl, gap: spacing.lg },
  drawer: { backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderTranslucent, borderRadius: radius.container, padding: spacing.lg, gap: spacing.md },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  scope: { flexShrink: 1, textAlign: 'right' },
  usageStrip: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xl },
  spark: { flex: 1, paddingBottom: spacing.xs },
  compactPlans: { gap: spacing.sm },
  usageDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.borderTranslucent, paddingTop: spacing.sm },
  section: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold, color: c.textPrimary },
  meta: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: c.textSecondary },
  // The widget's old-data line: orange, and only once the readings are old.
  stale: { fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.medium, color: c.statusAccent, flexShrink: 1 },
  number: { fontSize: typeScale.headline, lineHeight: lineHeight.headline, fontWeight: fontWeight.semibold, color: c.textPrimary, fontVariant: ['tabular-nums'] },
  hero: { fontSize: typeScale.largeTitle, lineHeight: lineHeight.largeTitle, fontWeight: fontWeight.semibold, color: c.textPrimary, fontVariant: ['tabular-nums'] },
  breakdown: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.borderTranslucent, paddingTop: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
