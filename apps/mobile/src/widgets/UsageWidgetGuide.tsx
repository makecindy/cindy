import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { CompanionSheet } from '@/session/CompanionSheet';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconStroke, spacing, textStyles, typeScale } from '@/theme/tokens';

const PHONE = { width: 132, height: 128, fadeFrom: 94 };
// Home Screen grid: four columns of app icons; the Cindy widget takes a 2 x 2 block.
const GRID = { columns: [15, 42, 69, 96], rows: [30, 57, 84, 111], icon: 21 };
const appIcons = GRID.rows.flatMap((y, row) => GRID.columns.slice(row < 2 ? 2 : 0).map(x => ({ x, y, faded: row === 3 })));
const quotaTubes = [21, 15, 10];
const trendBars = [8, 13, 10, 17];

/** The top of a phone, fading out below the part that shows where widgets sit. */
function PhoneTop({ id, children }: { id: string; children: ReactNode }) {
  const { colors } = useTheme();
  const fade = (name: string, color: string) =>
    <LinearGradient id={`${id}-${name}`} gradientUnits="userSpaceOnUse" x1={0} y1={PHONE.fadeFrom} x2={0} y2={PHONE.height}>
      <Stop offset={0} stopColor={color} stopOpacity={1} />
      <Stop offset={1} stopColor={color} stopOpacity={0} />
    </LinearGradient>;
  return <Svg width={PHONE.width} height={PHONE.height} viewBox={`0 0 ${PHONE.width} ${PHONE.height}`} accessible={false}>
    <Defs>{fade('edge', colors.borderStrong)}{fade('screen', colors.surfaceElevated)}</Defs>
    <Rect x={2} y={2} width={PHONE.width - 4} height={PHONE.height * 2} rx={24}
      fill={`url(#${id}-screen)`} stroke={`url(#${id}-edge)`} strokeWidth={iconStroke.regular} />
    {Platform.OS === 'android'
      ? <Circle cx={PHONE.width / 2} cy={14} r={3.5} fill={colors.borderStrong} />
      : <Rect x={PHONE.width / 2 - 16} y={10} width={32} height={9} rx={4.5} fill={colors.borderStrong} />}
    {children}
  </Svg>;
}

function HomeScreenPhone() {
  const { colors } = useTheme();
  const accent = colors.quotaWidgetPlenty;
  return <PhoneTop id="home">
    <Rect x={15} y={30} width={48} height={48} rx={12} fill={accent} fillOpacity={0.16} />
    {quotaTubes.map((level, i) => <Rect key={`tube-${i}`} x={22 + i * 13} y={41} width={8} height={26} rx={4} fill={accent} fillOpacity={0.26} />)}
    {quotaTubes.map((level, i) => <Rect key={`level-${i}`} x={22 + i * 13} y={67 - level} width={8} height={level} rx={4} fill={accent} />)}
    {appIcons.map(({ x, y, faded }) => <Rect key={`${x}-${y}`} x={x} y={y} width={GRID.icon} height={GRID.icon} rx={6}
      fill={colors.border} fillOpacity={faded ? 0.25 : 0.6} />)}
  </PhoneTop>;
}

function LockScreenPhone() {
  const { colors } = useTheme();
  const accent = colors.quotaWidgetPlenty;
  const ring = 2 * Math.PI * 9.5;
  return <PhoneTop id="lock">
    <Rect x={48} y={27} width={36} height={4} rx={2} fill={colors.border} />
    <SvgText x={66} y={63} textAnchor="middle" fill={colors.textPrimary} fontSize={typeScale.largeTitle} fontWeight={fontWeight.semibold}>9:41</SvgText>
    <Rect x={15} y={74} width={62} height={30} rx={9} fill={accent} fillOpacity={0.16} />
    {trendBars.map((height, i) => <Rect key={i} x={22 + i * 7} y={98 - height} width={4} height={height} rx={1.5} fill={accent} />)}
    <Rect x={54} y={83} width={17} height={4} rx={2} fill={accent} fillOpacity={0.6} />
    <Rect x={54} y={91} width={11} height={4} rx={2} fill={accent} fillOpacity={0.32} />
    <Circle cx={101} cy={89} r={15} fill={accent} fillOpacity={0.16} />
    {/* Quota ring: its band is drawn as a stroke, so the width is figure geometry (registered). */}
    <Circle cx={101} cy={89} r={9.5} fill="none" stroke={accent} strokeOpacity={0.26} strokeWidth={3.5} />
    <Circle cx={101} cy={89} r={9.5} fill="none" stroke={accent} strokeWidth={3.5} strokeLinecap="round"
      strokeDasharray={[ring * 0.68, ring]} transform="rotate(-90 101 89)" />
    <Rect x={15} y={112} width={102} height={30} rx={9} fill={colors.border} fillOpacity={0.25} />
  </PhoneTop>;
}

/** `lockScreenHint` is set where the system also offers these widgets on the Lock Screen. */
export function UsageWidgetGuide({ visible, instructions, lockScreenHint, onClose }: {
  visible: boolean; instructions: string; lockScreenHint?: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const s = useThemedStyles(styles);
  return <CompanionSheet visible={visible} onClose={onClose} title={t('devices.widgetGuideAction')} testID="usage.widgetGuide.sheet">
    <View style={s.content}>
      <Text style={s.intro}>{t('devices.widgetGuideIntro')}</Text>
      <View style={s.phones}>
        <View accessible accessibilityRole="image" accessibilityLabel={t('devices.widgetGuideExample')} style={s.phone}>
          <HomeScreenPhone />
          {lockScreenHint ? <Text style={s.caption}>{t('devices.widgetGuideHome')}</Text> : null}
        </View>
        {lockScreenHint ? <View style={s.phone}>
          <LockScreenPhone />
          <Text style={s.caption}>{t('devices.widgetGuideLock')}</Text>
        </View> : null}
      </View>
      <View style={s.steps}>{instructions.split('\n\n').map((step, index) =>
        <View key={index} style={s.step}>
          <Text style={s.index}>{index + 1}</Text><Text style={s.instruction}>{step}</Text>
        </View>)}</View>
      {lockScreenHint ? <Text style={s.hint}>{lockScreenHint}</Text> : null}
      <MainWindowActionButton action={{ label: t('devices.widgetGuideDismiss'), onPress: onClose }} />
    </View>
  </CompanionSheet>;
}

const styles = (c: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  intro: { ...textStyles.bodySmall, color: c.textPrimary },
  phones: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg },
  phone: { alignItems: 'center' },
  caption: { ...textStyles.caption, color: c.textSecondary },
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline' },
  index: { ...textStyles.bodySmall, fontWeight: fontWeight.medium, color: c.textSecondary },
  instruction: { flex: 1, ...textStyles.bodySmall, color: c.textPrimary },
  hint: { ...textStyles.footnote, color: c.textSecondary },
});
