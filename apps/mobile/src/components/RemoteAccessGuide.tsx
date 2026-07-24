import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Cloud, Lock } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, StatusDot } from '@/components/MobilePrimitives';
import type { MobileHomeNoDeviceContext } from '@/session/mobileHome';
import {
  fontWeight,
  iconSize,
  iconStroke,
  radius,
  spacing,
  textStyles,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';

/**
 * 首页「无可控制电脑」的产品模式引导态(home.emptyKind === 'noDevice' 时渲染)。
 *
 * 按「手机版官网 landing」的编辑排版承担首次使用的产品说明(排版语系对齐 login 品牌块:
 * 大写 eyebrow / 大标题 / 宽松副标,左对齐、不加外框),并按 emptyNoDevice.reason 分场景引导:
 * - firstRun:完整产品说明 + 「开始使用」三步卡(设置路径与开关名与桌面端逐字一致);
 * - offline:列出连接过的电脑与状态,引导去电脑上打开 Cindy,可手动重新检查;
 * - remoteDisabled:电脑在线只差开关,给精确路径 + 重新检查;
 * - accessRevoked:指名撤销访问的电脑(Lock 图标,对齐设备列表语义),主 CTA 重试访问。
 * 各场景都保留云端 Cindy 预告卡(未来形态:上线后手机版无需电脑直接使用)。
 *
 * hero 标题与导语文案来自 maker-shared 的 mobileHomeEmptyState(单一来源,已按 reason 分文案),
 * eyebrow、步骤、卡片与云端预告属于引导态自身的展示细节,收在本组件内。
 */

export function RemoteAccessGuide({
  context,
  copy,
  onRecheck,
  onRetryAccess,
  rechecking = false,
  retrying = false,
  style,
  testID,
  title,
}: {
  context: MobileHomeNoDeviceContext;
  copy: string;
  /** offline / remoteDisabled:手动触发一轮设备同步(与下拉刷新同源)。 */
  onRecheck?(): void;
  /** accessRevoked:向列出的设备重试申请访问。 */
  onRetryAccess?(): void;
  rechecking?: boolean;
  retrying?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { reason } = context;
  // 连接步骤文案。桌面端开关名称必须与 apps/desktop 设置页 devices.allowControl 保持一致。
  const connectSteps = [
    t('deviceLink.connectStep1'),
    t('deviceLink.connectStep2'),
    t('deviceLink.connectStep3'),
  ];
  const sectionLabels: Record<MobileHomeNoDeviceContext['reason'], string | null> = {
    firstRun: t('deviceLink.sectionFirstRun'),
    offline: t('deviceLink.sectionOffline'),
    remoteDisabled: t('deviceLink.sectionRemoteDisabled'),
    accessRevoked: t('deviceLink.sectionAccessRevoked'),
  };
  const sectionLabel = sectionLabels[reason];
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.heroBlock}>
        <Text style={styles.eyebrow}>{t('deviceLink.brandEyebrow')}</Text>
        <Text style={styles.heroTitle}>{title}</Text>
        <Text style={styles.lede}>{copy}</Text>
      </View>

      <View style={styles.section}>
        {sectionLabel ? <Text style={styles.sectionLabel}>{sectionLabel}</Text> : null}

        {reason === 'firstRun' ? (
          <View style={styles.card}>
            {connectSteps.map((step, index) => (
              <View key={step} style={styles.stepRow}>
                <View style={styles.stepBadge}>
                  <Text style={styles.stepBadgeText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {reason === 'offline' || reason === 'accessRevoked' ? (
          <View style={styles.card}>
            {context.devices.map((device) => (
              <View key={device.deviceId} style={styles.deviceRow} testID={`home.remoteGuide.device.${device.deviceId}`}>
                {reason === 'accessRevoked' ? (
                  // 「被锁在外」语义与设备列表一致:Lock 图标,不用状态点(设计指南 §6)。
                  <Lock color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                ) : (
                  <StatusDot tone="off" />
                )}
                <Text numberOfLines={1} style={styles.deviceName}>{device.name}</Text>
                {device.statusDetail ? (
                  <Text numberOfLines={1} style={styles.deviceStatus}>{device.statusDetail}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {reason === 'remoteDisabled' ? (
          <View style={styles.card}>
            <Text style={styles.instructionText}>{connectSteps[2]}</Text>
          </View>
        ) : null}

        {reason === 'accessRevoked' && onRetryAccess ? (
          <MainWindowActionButton
            action={{
              busy: retrying,
              label: t('deviceLink.retryAccess'),
              onPress: onRetryAccess,
              testID: 'home.remoteGuide.retryAccess',
              tone: 'primary',
            }}
            style={styles.ctaButton}
          />
        ) : null}

        {(reason === 'offline' || reason === 'remoteDisabled') && onRecheck ? (
          <MainWindowActionButton
            action={{
              busy: rechecking,
              label: t('deviceLink.recheck'),
              onPress: onRecheck,
              testID: 'home.remoteGuide.recheck',
            }}
            style={styles.ctaButton}
          />
        ) : null}
      </View>

      <View style={styles.teaserCard}>
        <Cloud color={colors.textSecondary} size={iconSize.lg} strokeWidth={iconStroke.thin} />
        <View style={styles.teaserBody}>
          <Text style={styles.teaserTitle}>{t('deviceLink.cloudTeaserTitle')}</Text>
          <Text style={styles.teaserCopy}>{t('deviceLink.cloudTeaserCopy')}</Text>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    gap: spacing.xl,
  },
  heroBlock: {
    gap: spacing.md,
  },
  eyebrow: {
    ...textStyles.caption,
    color: colors.textTertiary,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
  },
  heroTitle: {
    ...textStyles.largeTitle,
    color: colors.textPrimary,
    fontWeight: fontWeight.semibold,
  },
  lede: {
    ...textStyles.bodyRelaxed,
    color: colors.textSecondary,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    ...textStyles.caption,
    color: colors.textTertiary,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  stepRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
  },
  stepBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 22,
    justifyContent: 'center',
    // 行首序号圆点与首行文字对齐:徽标高 22、步骤文字行高 22,天然同高无需微调。
    width: 22,
  },
  stepBadgeText: {
    ...textStyles.caption,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  stepText: {
    ...textStyles.body,
    color: colors.textPrimary,
    flex: 1,
  },
  instructionText: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  deviceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  deviceName: {
    ...textStyles.body,
    color: colors.textPrimary,
    flexShrink: 1,
    fontWeight: fontWeight.medium,
  },
  deviceStatus: {
    ...textStyles.footnote,
    color: colors.textTertiary,
    flex: 1,
    textAlign: 'right',
  },
  ctaButton: {
    marginTop: spacing.xs,
    minHeight: 44,
  },
  teaserCard: {
    alignItems: 'flex-start',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  teaserBody: {
    flex: 1,
    gap: spacing.xs,
  },
  teaserTitle: {
    ...textStyles.footnote,
    color: colors.textPrimary,
    fontWeight: fontWeight.medium,
  },
  teaserCopy: {
    ...textStyles.footnote,
    color: colors.textSecondary,
  },
});
