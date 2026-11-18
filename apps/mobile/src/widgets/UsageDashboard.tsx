import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { MobileUsageWidgetSnapshot as Snapshot } from '@cindy/maker-shared/device-link-contract';
import { UsageQuotaColumns } from './UsageQuotaColumns';
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
    return [...models.map((model, index) => ({ label: model.name, color: palette[index % palette.length]!, index })),
      { label: other, color: colors.taskTagGray, index: models.length }]
      .map(bucket => ({ ...bucket, value: (day: Snapshot['usage']['daily'][number]) => day.modelTokens![bucket.index]! }));
  }
  return [{ label: 'Codex', color: colors.taskTagBlue, index: 1 },
    { label: 'Claude Code', color: colors.taskTagCoral, index: 0 },
    { label: 'Pi', color: colors.taskTagTeal, index: 2 }].map(bucket => ({
    ...bucket, value: (day: Snapshot['usage']['daily'][number]) => day.tokens[bucket.index]!,
  }));
}

function HistoryBars({ snapshot, small = false }: { snapshot: Snapshot; small?: boolean }) {
  const { colors } = useTheme();
  const days = snapshot.usage.daily.slice(-30);
  const max = Math.max(1, ...days.map(day => sum(day.tokens)));
  const { t } = useTranslation();
  const buckets = chartBuckets(snapshot.usage, colors, t('devices.usageOther'));
  const height = small ? 28 : 108;
  const average = days.length ? days.reduce((total, day) => total + sum(day.tokens), 0) / days.length : 0;
  return <View style={{ flexDirection: 'row', gap: small ? 2 : 3, height, alignItems: 'flex-end' }}>
    {days.map((day, index) => <View key={index} style={{ flex: 1, height: height * sum(day.tokens) / max,
      borderTopLeftRadius: 2, borderTopRightRadius: 2, overflow: 'hidden', flexDirection: 'column-reverse' }}>
      {buckets.map(bucket => bucket.value(day) > 0 && <View key={bucket.index} style={{ flex: bucket.value(day), backgroundColor: bucket.color }} />)}
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
  return <Pressable accessibilityRole="button" onPress={onOpen} testID="home.chromeDrawer.usage"
    style={({ pressed }) => [s.drawer, pressed && { backgroundColor: colors.surfaceChip }]}>
    <View style={s.between}><Text style={s.section}>{t('devices.usageTitle')}</Text>
      <ChevronRight size={iconSize.md} color={colors.textSecondary} /></View>
    {snapshot && preview.length > 0 ? <View style={s.compactPlans}>
      <View style={s.between}><Text style={s.meta}>{t('devices.usagePlans')}</Text>
        {accounts.length > preview.length && <Text style={s.meta}>+{accounts.length - preview.length}</Text>}</View>
      <UsageQuotaColumns sources={preview} strings={snapshot.strings} compact />
    </View> : null}
    {day && state?.kind === 'snapshot' ? <View style={preview.length > 0 ? s.usageDivider : undefined}>
      <View style={s.between}>
        <Text style={s.meta}>{usageDayLabel(state.snapshot, t('session.menu.usage.today'))} · {t('session.menu.usage.tokenUnit')}</Text>
        <TokenScope scope={state.snapshot.usage.scope} name={state.deviceName} />
      </View>
      <View style={s.usageStrip}>
        <Text style={s.number}>{compact(sum(day.tokens), i18n.language)}</Text>
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
  const buckets = chartBuckets(usage, colors, t('devices.usageOther'));
  const ranked = buckets.map(bucket => ({ label: bucket.label, color: bucket.color,
    tokens: usage.daily.reduce((total, row) => total + bucket.value(row), 0),
  })).filter(item => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const series = ranked.length > 4 ? [...ranked.slice(0, 3), { label: t('devices.usageOther'), color: colors.taskTagGray,
    tokens: ranked.slice(3).reduce((total, row) => total + row.tokens, 0) }] : ranked;
  const periodTotal = usage.daily.reduce((total, day) => total + sum(day.tokens), 0);
  const accounts = sources.filter(source => source.kind === 'subscription');
  return <View style={{ gap: spacing.lg }}>
    {name ? <Text style={s.section}>{name}</Text> : null}
      {accounts.length > 0 && <View style={s.card}>
        <Text style={s.section}>{t('devices.usagePlans')}</Text>
        <UsageQuotaColumns sources={accounts} strings={strings} />
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
  number: { fontSize: typeScale.headline, lineHeight: lineHeight.headline, fontWeight: fontWeight.semibold, color: c.textPrimary, fontVariant: ['tabular-nums'] },
  hero: { fontSize: typeScale.largeTitle, lineHeight: lineHeight.largeTitle, fontWeight: fontWeight.semibold, color: c.textPrimary, fontVariant: ['tabular-nums'] },
  breakdown: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.borderTranslucent, paddingTop: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
