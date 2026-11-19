import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { CompanionSheet } from '@/session/CompanionSheet';
import { MobileProviderMark } from '@/session/MobileProviderMark';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, radius, spacing, textStyles } from '@/theme/tokens';

// Illustrative readings, also available before the first desktop snapshot arrives.
const allowances = [
  { provider: 'anthropic', name: 'Claude', percent: 84 },
  { provider: 'openai', name: 'OpenAI', percent: 42 },
  { provider: 'xai', name: 'Grok', percent: 18 },
];
const dailyBars = [12, 19, 15, 28, 22, 32, 25];

export function UsageWidgetGuide({ visible, instructions, onClose }: {
  visible: boolean; instructions: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const s = useThemedStyles(styles);
  const example = t('devices.widgetGuideExample');
  const quota = t('devices.widgetGuideQuota');
  const usage = t('devices.widgetGuideDaily');
  return <CompanionSheet visible={visible} onClose={onClose} title={t('devices.widgetGuideAction')} testID="usage.widgetGuide.sheet">
    <View style={s.content}>
      <Text style={s.intro}>{t('devices.widgetGuideIntro')}</Text>
      <View style={s.preview} accessible accessibilityRole="image" accessibilityLabel={[example, quota, usage].join(' · ')}>
        <Text style={s.caption}>{example}</Text>
        <View style={s.tiles}>
          <View style={s.tile}>
            <Text style={s.label}>{quota}</Text>
            <View style={s.meters}>{allowances.map(({ provider, name, percent }) =>
              <View key={provider} style={s.meter}>
                <Text style={s.percent}>{percent}%</Text>
                <View style={s.tube}><View style={[s.fill, { height: `${percent}%` }, percent <= 30 && s.low]} /></View>
                <MobileProviderMark logoKind={provider} name={name} />
              </View>)}</View>
          </View>
          <View style={s.tile}>
            <Text style={s.label}>{usage}</Text>
            <Text style={s.total}>257K <Text style={s.caption}>{t('session.menu.usage.tokenUnit')}</Text></Text>
            <View style={s.chart}>{dailyBars.map((height, index) =>
              <View key={index} style={[s.bar, { height }]}><View style={s.barTop} /></View>)}</View>
          </View>
        </View>
      </View>
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
  preview: { padding: spacing.md, gap: spacing.sm, borderRadius: radius.container, backgroundColor: c.surfaceChip },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: { flex: 1, minWidth: 0, padding: spacing.sm, gap: spacing.xs, borderRadius: radius.container, backgroundColor: c.surfaceElevated },
  label: { ...textStyles.footnote, fontWeight: fontWeight.semibold, color: c.textPrimary },
  caption: { ...textStyles.caption, color: c.textSecondary, fontWeight: fontWeight.regular },
  meters: { flexDirection: 'row', justifyContent: 'space-around' },
  meter: { alignItems: 'center', gap: 2 },
  percent: { ...textStyles.caption, fontVariant: ['tabular-nums'], fontWeight: fontWeight.semibold, color: c.textPrimary },
  tube: { width: 17, height: 36, padding: 2, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.borderStrong, justifyContent: 'flex-end' },
  fill: { backgroundColor: c.quotaWidgetPlenty, borderRadius: radius.control },
  low: { backgroundColor: c.quotaBarWarn },
  chart: { flex: 1, flexDirection: 'row', gap: 3, alignItems: 'flex-end', paddingBottom: spacing.xs },
  bar: { flex: 1, backgroundColor: c.taskTagTeal, overflow: 'hidden', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  barTop: { height: '35%', backgroundColor: c.taskTagPurple },
  total: { ...textStyles.headline, color: c.textPrimary, fontWeight: fontWeight.semibold },
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline' },
  index: { ...textStyles.bodySmall, fontWeight: fontWeight.medium, color: c.textSecondary },
  instruction: { flex: 1, ...textStyles.bodySmall, color: c.textPrimary },
});
