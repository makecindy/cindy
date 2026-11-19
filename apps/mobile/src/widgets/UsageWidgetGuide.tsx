import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { CompanionSheet } from '@/session/CompanionSheet';
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, spacing, textStyles, typeScale } from '@/theme/tokens';

// A single Home Screen grid: the chart widget occupies four app-icon slots.
const appIcons = [
  { x: 77, y: 30, path: 'M5 8h14v10H5z M5 8l7 5 7-5' },
  { x: 77, y: 57, path: 'M5 10a7 6 0 0 1 14 0v2a7 6 0 0 1-7 6H9l-4 2 1-5a6 6 0 0 1-1-5z' },
  { x: 17, y: 87, path: 'M4 9h4l2-3h4l2 3h4v10H4z M15 13a3 3 0 1 1-6 0 3 3 0 1 1 6 0z' },
  { x: 47, y: 87, path: 'M6 7h12v12H6z M6 11h12 M9 5v4 M15 5v4' },
  { x: 77, y: 87, path: 'M10 16V7l8-2v9 M10 16a2 2 0 1 1-4 0 2 2 0 1 1 4 0 M18 14a2 2 0 1 1-4 0 2 2 0 1 1 4 0' },
];

function HomeScreenIllustration({ label }: { label: string }) {
  const { colors } = useTheme();
  return <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ alignItems: 'center' }}>
    <Svg width={116} height={159} viewBox="0 0 116 159" accessible={false}>
      <Rect x={4} y={2} width={108} height={155} rx={18} fill={colors.surfaceElevated} stroke={colors.borderStrong} strokeWidth={2} />
      <Rect x={47} y={9} width={22} height={4} rx={2} fill={colors.borderStrong} />
      <Rect x={17} y={30} width={53} height={50} rx={9} fill={colors.quotaWidgetPlenty} fillOpacity={0.16} />
      <SvgText x={23} y={45} fill={colors.textPrimary} fontSize={typeScale.micro} fontWeight={fontWeight.semibold}>Cindy</SvgText>
      {[10, 15, 12, 21, 17].map((height, i) => <Rect key={i} x={24 + i * 8} y={72 - height}
        width={5} height={height} rx={1.5} fill={colors.quotaWidgetPlenty} />)}
      {appIcons.map(({ x, y, path }) => <G key={path} transform={`translate(${x} ${y})`}>
        <Rect width={23} height={23} rx={6} fill={colors.surfaceChip} />
        <Path d={path} fill="none" stroke={colors.textSecondary} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      </G>)}
      <Rect x={42} y={147} width={32} height={2.5} rx={1.25} fill={colors.borderStrong} />
    </Svg>
  </View>;
}

export function UsageWidgetGuide({ visible, instructions, onClose }: {
  visible: boolean; instructions: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const s = useThemedStyles(styles);
  return <CompanionSheet visible={visible} onClose={onClose} title={t('devices.widgetGuideAction')} testID="usage.widgetGuide.sheet">
    <View style={s.content}>
      <Text style={s.intro}>{t('devices.widgetGuideIntro')}</Text>
      <HomeScreenIllustration label={t('devices.widgetGuideExample')} />
      <View style={s.steps}>{instructions.split('\n\n').map((step, index) =>
        <View key={index} style={s.step}>
          <Text style={s.index}>{index + 1}</Text><Text style={s.instruction}>{step}</Text>
        </View>)}</View>
      <MainWindowActionButton action={{ label: t('devices.widgetGuideDismiss'), onPress: onClose }} />
    </View>
  </CompanionSheet>;
}

const styles = (c: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  intro: { ...textStyles.bodySmall, color: c.textPrimary },
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline' },
  index: { ...textStyles.bodySmall, fontWeight: fontWeight.medium, color: c.textSecondary },
  instruction: { flex: 1, ...textStyles.bodySmall, color: c.textPrimary },
});
