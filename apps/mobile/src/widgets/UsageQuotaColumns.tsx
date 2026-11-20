import { useEffect, useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import type { MobileUsageWidgetSnapshot, MobileUsageWidgetSource as Source } from '@cindy/maker-shared/device-link-contract';
import { resetTimeLevel } from '@cindy/maker-shared/quota-level';
import { Text } from '@/components/AppText';
import { MobileProviderMark } from '@/session/MobileProviderMark';
import { CountUp, OpeningLiquid, TUBE_STAGGER } from './usageOpeningMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconStroke, spacing, textStyles } from '@/theme/tokens';

type Strings = MobileUsageWidgetSnapshot['strings'];
const providerMarks = { claude: 'anthropic', codex: 'openai', grok: 'xai', cindy: 'cindy', kimi: undefined };

function resetLabel(source: Source, now: number, strings: Strings, compact: boolean, expired: string) {
  if (source.stale || source.resetsAtMs == null) return source.when;
  const left = source.resetsAtMs - now;
  if (left <= 0) return expired;
  const minutes = Math.max(1, Math.floor(left / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor(minutes % 1440 / 60);
  const m = minutes % 60;
  let key = 'minutes';
  if (d) key = !compact && h ? 'daysHours' : 'days';
  else if (h) key = !compact && m ? 'hoursMinutes' : 'hours';
  const duration = strings['durationShort.' + key]?.replace('{{d}}', String(d)).replace('{{h}}', String(h)).replace('{{m}}', String(m)) ?? source.when;
  return !compact && duration && strings.resetsIn ? strings.resetsIn.replace('{{duration}}', duration) : duration;
}

function QuotaTube({ source, small, stale, panel, opening }: {
  source: Source; small: boolean; stale: boolean; panel: boolean;
  /** Position in the row when the liquid plays the opening; absent, it is drawn still. */
  opening?: number;
}) {
  const { colors, mode } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const width = small ? 22 : 30, height = small ? 46 : 74;
  const inset = 3, innerHeight = height - 2 * inset, innerWidth = width - 2 * inset;
  const corner = Math.min(13, width / 2);
  const fill = Math.min(1, Math.max(0, source.fill));
  const liquid = fill === 0 ? 0 : Math.max(3, innerHeight * fill);
  const alert = source.level === 'error' ? colors.quotaBarCrit : source.level === 'warn' ? colors.quotaBarWarn : null;
  // With plenty left the widget's liquid is teal. The menu bar panel's is its ink at an
  // opacity, so the well shows through and only a low level brings color.
  const tint = alert ?? (panel ? colors.textPrimary : colors.quotaWidgetPlenty);
  const tintOpacity = alert || !panel ? 1 : mode === 'dark' ? 0.72 : 0.46;
  return <Svg width={width} height={height} accessible={false} opacity={stale ? 0.45 : 1}>
    <Defs>
      <LinearGradient id={'well' + id} x1="0%" y1="0%" x2="0%" y2="100%">
        <Stop offset="0" stopColor={colors.surfaceElevated} /><Stop offset="1" stopColor={colors.surfaceChip} />
      </LinearGradient>
      <ClipPath id={'clip' + id}><Rect x={inset} y={inset} width={innerWidth} height={innerHeight} rx={corner - inset} /></ClipPath>
    </Defs>
    {/* Tube wall: a hairline like the widget's, slightly heavier when emphasized (registered geometry). */}
    <Rect x={0.5} y={0.5} width={width - 1} height={height - 1} rx={corner} fill={'url(#well' + id + ')'}
      stroke={source.emphasized ? colors.borderStrong : colors.borderTranslucent} strokeWidth={source.emphasized ? 1.25 : 1} />
    <G clipPath={'url(#clip' + id + ')'}>
      {source.reserve && <Path d={Array.from({ length: Math.ceil((height + width) / 7) }, (_, i) =>
        `M${i * 7 - height},${height} l${height},-${height}`).join(' ')} stroke={colors.borderTranslucent} strokeWidth={iconStroke.regular} />}
      {liquid > 0 && (opening == null
        ? <Rect x={inset} y={height - inset - liquid} width={innerWidth} height={liquid + 4} rx={Math.min(4, liquid / 2)} fill={tint} fillOpacity={tintOpacity} />
        : <OpeningLiquid x={inset} bottom={height - inset} width={innerWidth} level={liquid} fraction={fill} index={opening} fill={tint} fillOpacity={tintOpacity} />)}
    </G>
  </Svg>;
}

/**
 * `stale` dims every tube: the whole snapshot is old, not only the sources the computer marked.
 * `palette` picks whose colors the tubes wear: the Home Screen widget's or the menu bar panel's.
 * `opening` plays the menu bar panel's opening once: rising liquid and numbers counting up,
 * read in the snapshot's `locale`.
 */
export function UsageQuotaColumns({ sources, strings, compact = false, stale = false, palette = 'widget', opening = false, locale = 'en-US' }: {
  sources: Source[]; strings: Strings; compact?: boolean; stale?: boolean; palette?: 'widget' | 'panel'; opening?: boolean; locale?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useThemedStyles(styles);
  const [now, setNow] = useState(Date.now);
  const [availableWidth, setAvailableWidth] = useState(320);
  const ticking = sources.some(source => !source.stale && source.resetsAtMs != null);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const maxColumns = compact ? 4 : Math.max(1, Math.min(6, Math.floor(availableWidth / 82)));
  const rows = Math.ceil(sources.length / maxColumns);
  const columns = rows ? Math.ceil(sources.length / rows) : 1;
  const hasCreditUnit = sources.some(source => source.reserve && source.unit && source.value != null);
  const expired = t('session.menu.usage.awaitingRefresh');
  return <View style={s.grid} onLayout={e => setAvailableWidth(e.nativeEvent.layout.width)}>
    {sources.map((source, index) => {
      const value = source.value ?? source.label ?? '—';
      const unit = source.value == null ? null : source.unit;
      const when = resetLabel(source, now, strings, compact, expired);
      const level = resetTimeLevel((source.resetsAtMs ?? 0) - now, !source.stale && !!source.unusedAtReset);
      const fullWhen = compact ? resetLabel(source, now, strings, false, expired) : when;
      return <View key={source.id} style={[s.column, { width: `${100 / columns}%` }]} accessible
        accessibilityLabel={[source.name, value + (unit ?? ''), fullWhen].filter(Boolean).join(', ')}>
        <Text style={[s.value, compact && s.smallValue]} adjustsFontSizeToFit numberOfLines={1}>
          {opening && source.value != null ? <CountUp text={value} locale={locale} delay={index * TUBE_STAGGER} play /> : value}
          {unit && !source.reserve && <Text style={s.unit}>{unit}</Text>}
        </Text>
        {hasCreditUnit && <Text numberOfLines={1} style={s.unit}>{source.reserve ? unit : ' '}</Text>}
        <QuotaTube source={source} small={compact} stale={stale || !!source.stale} panel={palette === 'panel'} opening={opening ? index : undefined} />
        <View style={[s.identity, compact && s.stackedIdentity]}>
          <MobileProviderMark name={source.monogram || source.name} color={colors.textPrimary}
            logoKind={source.logo ? providerMarks[source.logo] : undefined} providerId={source.logo === 'kimi' ? 'kimi-coding' : undefined} />
          <Text numberOfLines={compact ? 1 : 2} style={[s.name, compact && s.centerName]}>{source.name}</Text>
        </View>
        {!!when && <Text numberOfLines={compact ? 1 : 2} style={[s.when, level === 'crit' && s.quotaResetCrit, level === 'warn' && s.quotaResetWarn]}>{when}</Text>}
      </View>;
    })}
  </View>;
}

const styles = (c: ThemeColors) => StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.lg },
  column: { alignItems: 'center', paddingHorizontal: 2 },
  value: { ...textStyles.title, color: c.textPrimary, fontWeight: fontWeight.semibold, fontVariant: ['tabular-nums'], marginBottom: spacing.xs },
  smallValue: { ...textStyles.body },
  unit: { ...textStyles.caption, color: c.textSecondary, fontWeight: fontWeight.regular },
  identity: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.xs, gap: 2, maxWidth: '100%' },
  stackedIdentity: { flexDirection: 'column', gap: 0 },
  centerName: { textAlign: 'center' },
  quotaResetCrit: { color: c.quotaBarCrit },
  quotaResetWarn: { color: c.quotaBarWarn },
  name: { ...textStyles.caption, color: c.textPrimary, flexShrink: 1 },
  when: { ...textStyles.caption, color: c.textSecondary, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
