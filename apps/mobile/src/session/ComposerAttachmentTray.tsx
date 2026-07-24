/**
 * Composer 附件托盘(会话页 / 新建会话页共用)。
 *
 * 图片附件且有本地预览 uri → 缩略图卡(对照 Cursor):可点开全屏查看、右上角 X 移除;
 * 其余附件(文档 / 远程路径 / 无本地预览的图片)→ 沿用「文件名 · 大小 + X」文本 chip。
 * 预览 uri 由页面在上传成功时记录(attachmentId → file://),真相仍是 attachments 列表。
 *
 * pendingUploads:乐观上传中的本机附件(拍照 / 相册 / 文件)。图片=缩略图立即可见
 * 盖转圈遮罩;文件=「文件名 · 大小」chip 带转圈。X 走 onRemovePending(取消上传),
 * 上传成功后由页面转为正式 attachment。
 */
import { Pen, RefreshCw, X } from 'lucide-react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import type { RemoteSerializedAttachment } from '@/session/types';
import type { PendingLocalAttachmentUpload } from '@/session/mobileLocalAttachmentUpload';
import { attachmentDisplayLabel, pendingUploadDisplayLabel } from '@/session/attachments';
import { ANNOTATION_OUTLINE_COLOR, ANNOTATION_STROKE_COLOR } from '@/session/imageAnnotationModel';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** 输入卡内的缩略图为正方形(产品决策,不用横长方)。 */
const THUMB_SIZE = 72;

export interface ComposerAttachmentTrayProps {
  attachments: readonly RemoteSerializedAttachment[];
  /** attachmentId → 本地预览 uri(仅本机图片附件有)。 */
  previews: Readonly<Record<string, string>>;
  onRemove: (attachmentId: string) => void;
  /** 点缩略图查看全图(页面负责挂 ImageLightbox)。 */
  onPreview: (attachmentId: string) => void;
  /** 乐观上传中的本机附件(图片=缩略卡,文件=chip,均带转圈;失败态带重试)。 */
  pendingUploads?: readonly PendingLocalAttachmentUpload[];
  /** X 一个上传中的附件(取消上传)。 */
  onRemovePending?: (localId: string) => void;
  /** 重试一个失败态的上传卡。 */
  onRetryPending?: (localId: string) => void;
  /**
   * 粘贴占位卡数量:原生层已检测到图片粘贴、数据还在后台读取的窗口(跨设备
   * 剪贴板走网络 / 大图重编码)。渲染 N 张无图转圈卡,onPasteImages 兑现后
   * 被真正的 pending 缩略卡原位接替。
   */
  pastePlaceholderCount?: number;
  removeDisabled?: boolean;
  removeDisabledReason?: string;
  testIDPrefix: string;
}

export function ComposerAttachmentTray({
  attachments,
  previews,
  onRemove,
  onPreview,
  pendingUploads = [],
  onRemovePending,
  onRetryPending,
  pastePlaceholderCount = 0,
  removeDisabled,
  removeDisabledReason,
  testIDPrefix,
}: ComposerAttachmentTrayProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeTrayStyles);
  const { colors } = useTheme();
  if (attachments.length === 0 && pendingUploads.length === 0 && pastePlaceholderCount === 0) return null;
  return (
    <View style={styles.tray} testID={`${testIDPrefix}.attachmentTray`}>
      {attachments.map((attachment) => {
        const preview = attachment.category === 'image' ? previews[attachment.id] : undefined;
        if (preview) {
          return (
            <View key={attachment.id} style={styles.thumbCard} testID={`${testIDPrefix}.attachmentThumb`}>
              <Pressable
                accessibilityLabel={t('composer.attachments.viewImage', { name: attachment.name })}
                accessibilityRole="button"
                onPress={() => onPreview(attachment.id)}
                style={({ pressed }) => [styles.thumbPressable, pressed && styles.pressed]}
                testID={`${testIDPrefix}.attachmentThumbPreview`}
              >
                <Image contentFit="cover" source={{ uri: preview }} style={styles.thumbImage} transition={0} />
                {attachment.annotated ? (
                  // 圈点标注角标:提示这张是带手绘标注的烧录图,点开可继续编辑/撤销。
                  // 微徽标几何(designTokenDiscipline 登记);icon 用标注体系描边白,
                  // 恒红底上跨主题恒定,与桌面标注视觉同族。
                  <View style={styles.thumbAnnotatedBadge} testID={`${testIDPrefix}.attachmentAnnotatedBadge`}>
                    <Pen color={ANNOTATION_OUTLINE_COLOR} size={10} strokeWidth={2.5} />
                  </View>
                ) : null}
              </Pressable>
              <Pressable
                accessibilityHint={removeDisabledReason}
                accessibilityLabel={t('composer.attachments.removeAttachment', { name: attachment.name })}
                accessibilityRole="button"
                disabled={removeDisabled}
                hitSlop={6}
                onPress={() => onRemove(attachment.id)}
                style={({ pressed }) => [styles.thumbRemove, pressed && styles.pressed]}
                testID={`${testIDPrefix}.attachmentRemoveButton`}
              >
                <X color={colors.textPrimary} size={iconSize.xs} strokeWidth={iconStroke.bold} />
              </Pressable>
            </View>
          );
        }
        return (
          <View key={attachment.id} style={styles.chip} testID={`${testIDPrefix}.attachmentChip`}>
            <Text numberOfLines={1} style={styles.chipText}>
              {attachmentDisplayLabel(attachment)}
            </Text>
            <Pressable
              accessibilityHint={removeDisabledReason}
              accessibilityLabel={t('composer.attachments.removeAttachment', { name: attachment.name })}
              accessibilityRole="button"
              disabled={removeDisabled}
              hitSlop={8}
              onPress={() => onRemove(attachment.id)}
              style={({ pressed }) => [styles.chipRemove, pressed && styles.pressed]}
              testID={`${testIDPrefix}.attachmentRemoveButton`}
            >
              <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
            </Pressable>
          </View>
        );
      })}
      {pendingUploads.map((pending) => (pending.kind === 'image' ? (
        <View key={pending.localId} style={styles.thumbCard} testID={`${testIDPrefix}.attachmentPendingThumb`}>
          <View style={styles.thumbPressable}>
            <Image contentFit="cover" source={{ uri: pending.previewUri }} style={styles.thumbImage} transition={0} />
            {pending.failed ? (
              // 失败态:遮罩变为可点的「重试」——弱网下让用户原地重试,不用重新找图。
              <Pressable
                accessibilityLabel={t('composer.attachments.retryUpload', { name: pending.name })}
                accessibilityRole="button"
                onPress={() => onRetryPending?.(pending.localId)}
                style={({ pressed }) => [styles.thumbBusyOverlay, pressed && styles.pressed]}
                testID={`${testIDPrefix}.attachmentPendingRetryButton`}
              >
                <RefreshCw color={colors.ctaText} size={iconSize.md} strokeWidth={iconStroke.bold} />
                <Text style={styles.thumbFailedText}>{t('composer.attachments.retry')}</Text>
              </Pressable>
            ) : (
              <View style={styles.thumbBusyOverlay}>
                <ActivityIndicator color={colors.ctaText} size="small" />
              </View>
            )}
          </View>
          <Pressable
            accessibilityHint={removeDisabledReason}
            accessibilityLabel={pending.failed ? t('composer.attachments.removeFailed', { name: pending.name }) : t('composer.attachments.cancelUpload', { name: pending.name })}
            accessibilityRole="button"
            disabled={removeDisabled}
            hitSlop={6}
            onPress={() => onRemovePending?.(pending.localId)}
            style={({ pressed }) => [styles.thumbRemove, pressed && styles.pressed]}
            testID={`${testIDPrefix}.attachmentPendingRemoveButton`}
          >
            <X color={colors.textPrimary} size={iconSize.xs} strokeWidth={iconStroke.bold} />
          </Pressable>
        </View>
      ) : (
        <View key={pending.localId} style={styles.chip} testID={`${testIDPrefix}.attachmentPendingChip`}>
          {pending.failed ? (
            <Pressable
              accessibilityLabel={t('composer.attachments.retryUpload', { name: pending.name })}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onRetryPending?.(pending.localId)}
              style={({ pressed }) => pressed && styles.pressed}
              testID={`${testIDPrefix}.attachmentPendingRetryButton`}
            >
              <RefreshCw color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.bold} />
            </Pressable>
          ) : (
            <ActivityIndicator color={colors.textSecondary} size="small" />
          )}
          <Text numberOfLines={1} style={styles.chipText}>
            {pending.failed ? t('composer.attachments.uploadFailed', { name: pending.name }) : pendingUploadDisplayLabel(pending)}
          </Text>
          <Pressable
            accessibilityHint={removeDisabledReason}
            accessibilityLabel={pending.failed ? t('composer.attachments.removeFailed', { name: pending.name }) : t('composer.attachments.cancelUpload', { name: pending.name })}
            accessibilityRole="button"
            disabled={removeDisabled}
            hitSlop={8}
            onPress={() => onRemovePending?.(pending.localId)}
            style={({ pressed }) => [styles.chipRemove, pressed && styles.pressed]}
            testID={`${testIDPrefix}.attachmentPendingRemoveButton`}
          >
            <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </Pressable>
        </View>
      )))}
      {Array.from({ length: pastePlaceholderCount }, (_, index) => (
        // 粘贴占位卡:还拿不到图片数据(原生后台读取中),灰底 + 转圈占住席位,
        // 让「粘贴」到「缩略图可见」之间没有任何空窗。无 X:此阶段没有可取消的
        // 上传任务,失败 / 超时由 hook 统一撤卡。
        <View
          key={`paste-placeholder-${index}`}
          style={styles.thumbCard}
          testID={`${testIDPrefix}.attachmentPastePlaceholder`}
        >
          <View style={[styles.thumbPressable, styles.pastePlaceholderBody]}>
            <ActivityIndicator color={colors.textSecondary} size="small" />
          </View>
        </View>
      ))}
    </View>
  );
}

export interface ComposerAttachmentCollapsedBadgeProps {
  attachments: readonly RemoteSerializedAttachment[];
  previews: Readonly<Record<string, string>>;
  /** 乐观上传中的本机附件(计数并入,首图缺预览时用 pending 图片的本地 uri 兜底)。 */
  pendingUploads?: readonly PendingLocalAttachmentUpload[];
  /** 粘贴占位卡数量(计数并入;没有可用预览图)。 */
  pastePlaceholderCount?: number;
  /** 点击展开 composer(页面通常聚焦输入框,card 态出现后显示完整托盘)。 */
  onPress: () => void;
  testID?: string;
}

const COLLAPSED_BADGE_SIZE = 30;

/**
 * composer 收起态的附件徽标(对照 Cursor):首张图片附件的迷你缩略图,
 * 多附件时叠「+N」;没有图片预览时退化为计数圆片。挂在输入行 leading 插槽。
 */
export function ComposerAttachmentCollapsedBadge({
  attachments,
  previews,
  pendingUploads = [],
  pastePlaceholderCount = 0,
  onPress,
  testID,
}: ComposerAttachmentCollapsedBadgeProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeTrayStyles);
  const count = attachments.length + pendingUploads.length + pastePlaceholderCount;
  if (count === 0) return null;
  let firstPreview: string | undefined;
  for (const attachment of attachments) {
    if (attachment.category === 'image' && previews[attachment.id]) {
      firstPreview = previews[attachment.id];
      break;
    }
  }
  if (!firstPreview) {
    firstPreview = pendingUploads.find((pending) => pending.kind === 'image')?.previewUri;
  }
  const extra = count - 1;
  return (
    <Pressable
      accessibilityLabel={t('composer.attachments.collapsedBadge', { count })}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.collapsedBadge, pressed && styles.pressed]}
      testID={testID}
    >
      {firstPreview ? (
        <Image contentFit="cover" source={{ uri: firstPreview }} style={styles.collapsedBadgeImage} transition={0} />
      ) : (
        <View style={styles.collapsedBadgeFallback}>
          <Text style={styles.collapsedBadgeFallbackText}>{count}</Text>
        </View>
      )}
      {firstPreview && extra > 0 ? (
        <View style={styles.collapsedBadgeOverlay}>
          <Text style={styles.collapsedBadgeOverlayText}>{`+${extra}`}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function makeTrayStyles(colors: ThemeColors) {
  return {
    tray: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    thumbCard: {
      height: THUMB_SIZE,
      width: THUMB_SIZE,
    },
    thumbPressable: {
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      height: '100%' as const,
      overflow: 'hidden' as const,
      width: '100%' as const,
    },
    thumbImage: {
      height: '100%' as const,
      width: '100%' as const,
    },
    // 粘贴占位卡体:图片数据未到,用 chip 底色居中转圈(不用深 scrim——没有
    // 底图可压,深底会显得像故障)。
    pastePlaceholderBody: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      justifyContent: 'center' as const,
    },
    // 上传中遮罩:深色 scrim 让缩略图「在但未就绪」,转圈用 ctaText(浅色主题为白)。
    thumbBusyOverlay: {
      alignItems: 'center' as const,
      backgroundColor: colors.overlay,
      bottom: 0,
      gap: 2,
      justifyContent: 'center' as const,
      left: 0,
      position: 'absolute' as const,
      right: 0,
      top: 0,
    },
    // 失败态遮罩上的「重试」文字(与转圈同用 ctaText,深 scrim 上跨主题可读)。
    thumbFailedText: {
      color: colors.ctaText,
      fontSize: typeScale.micro,
      fontWeight: fontWeight.semibold,
    },
    // 标注角标:左下角红底画笔(标注红为语义豁免色,跨主题恒定,引语义常量)。
    thumbAnnotatedBadge: {
      alignItems: 'center' as const,
      backgroundColor: ANNOTATION_STROKE_COLOR,
      borderRadius: radius.pill,
      bottom: 4,
      height: 18,
      justifyContent: 'center' as const,
      left: 4,
      position: 'absolute' as const,
      width: 18,
    },
    thumbRemove: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 22,
      justifyContent: 'center' as const,
      position: 'absolute' as const,
      right: 4,
      top: 4,
      width: 22,
    },
    chip: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flexDirection: 'row' as const,
      gap: spacing.sm,
      paddingLeft: spacing.lg,
      paddingRight: spacing.md,
      paddingVertical: 8,
    },
    chipText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      maxWidth: 220,
    },
    chipRemove: {
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    pressed: {
      opacity: 0.7,
    },
    collapsedBadge: {
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      height: COLLAPSED_BADGE_SIZE,
      marginRight: spacing.sm,
      overflow: 'hidden' as const,
      width: COLLAPSED_BADGE_SIZE,
    },
    collapsedBadgeImage: {
      height: '100%' as const,
      width: '100%' as const,
    },
    collapsedBadgeFallback: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      height: '100%' as const,
      justifyContent: 'center' as const,
      width: '100%' as const,
    },
    collapsedBadgeFallbackText: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.semibold,
    },
    collapsedBadgeOverlay: {
      alignItems: 'center' as const,
      backgroundColor: colors.overlay,
      bottom: 0,
      justifyContent: 'center' as const,
      left: 0,
      position: 'absolute' as const,
      right: 0,
      top: 0,
    },
    // 与 thumbBusyOverlay 同精神:深色 scrim 上用 ctaText(浅色主题为白)。
    collapsedBadgeOverlayText: {
      color: colors.ctaText,
      fontSize: typeScale.micro,
      fontWeight: fontWeight.semibold,
    },
  };
}
