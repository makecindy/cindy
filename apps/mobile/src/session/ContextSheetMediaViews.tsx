/**
 * Context 面板的媒体视图:最近照片横向条(主视图顶部)+ 截图网格(二级视图)。
 *
 * 两者共用 useContextSheetMediaAssets 加载资产,点选走页面注入的 onToggleAsset
 * (页面负责 getAssetInfoAsync 换 localUri → 原生直传既有 presign→OSS 链路)。
 * 选中态由页面传入 selectedAssetIds(assetId ↔ 附件映射的真相在页面)。
 *
 * 页面传入 selection 时,缩略图右上角多一个选择圈:点圈是多选(先留在面板里,由底部按钮
 * 一次加入);点照片本身仍是单张即加入。已经选了照片后,点照片也按选中 / 取消处理,
 * 免得一次误触把已选的丢掉(2026-11-16 用户要求)。
 */
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
// RN 的 Image 在新架构下不支持 ph:// 相册 URI(facebook/react-native#36136),
// 缩略图走 expo-image:原生支持 ph://,且按视图尺寸解码,不会整张原图进内存。
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  Pressable,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { Text } from '@/components/AppText';
import { useContextSheetDismissAction } from '@/session/ContextSheet';
import type { ContextSheetMediaSelection } from '@/session/ContextSheetMediaSelection';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  useContextSheetMediaAssets,
  type ContextSheetMediaAsset,
} from '@/session/useContextSheetMediaAssets';

const STRIP_THUMB_SIZE = 80;
/** 选择圈的点按区域:可见的圈只有 22,热区按独立触控目标补到 44×44。 */
const SELECT_HIT_SIZE = 44;
const GRID_COLUMNS = 3;

export interface ContextSheetMediaCallbacks {
  /** 单张点按即加入附件，由页面同步入队并关闭面板。 */
  onToggleAsset: (asset: ContextSheetMediaAsset, dismiss?: (afterClose: () => void) => void) => void;
  /** 已附加为附件的 assetId 集(展示勾选角标)。 */
  selectedAssetIds: ReadonlySet<string>;
  /** 正在上传中的 assetId 集(对应格子显示 spinner 并禁点;其余照常可选——上传已后台并发,不再整面板锁定)。 */
  busyAssetIds?: ReadonlySet<string>;
  disabled?: boolean;
  /** 多选待选集;提供后每张缩略图显示选择圈。 */
  selection?: ContextSheetMediaSelection;
}

/** 主视图顶部的最近照片横向条(对照设计稿 PhotoStrip)。 */
export function RecentPhotosStrip({
  enabled,
  onToggleAsset,
  selectedAssetIds,
  busyAssetIds,
  disabled,
  selection,
  testID,
}: ContextSheetMediaCallbacks & { enabled: boolean; testID?: string }) {
  const dismiss = useContextSheetDismissAction();
  const selecting = !!selection && selection.assets.length > 0;
  const styles = useThemedStyles(makeMediaStyles);
  const media = useContextSheetMediaAssets({ enabled, kind: 'recent' });

  if (media.status === 'unavailable') return null;
  if (media.status === 'denied') {
    return (
      <PermissionHint
        onRequest={media.requestPermission}
        testID={testID ? `${testID}.permission` : undefined}
      />
    );
  }
  if (media.status !== 'ready' || media.assets.length === 0) {
    // loading / 空相册都不占位:面板结构稳定,资产就绪后再出现(规则 7,不闪骨架)。
    return null;
  }
  return (
    <ScrollView
      contentContainerStyle={styles.stripContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      testID={testID}
    >
      {media.assets.map((asset) => (
        <MediaThumb
          asset={asset}
          busy={busyAssetIds?.has(asset.id) ?? false}
          disabled={disabled || selectedAssetIds.has(asset.id) || busyAssetIds?.has(asset.id)}
          key={asset.id}
          // Validate/enqueue immediately; the caller can defer focus until dismissal.
          onPress={() => (selecting ? selection.toggle(asset) : onToggleAsset(asset, dismiss))}
          onToggleSelect={selection ? () => selection.toggle(asset) : undefined}
          pendingIndex={selection?.order.get(asset.id)}
          selected={selectedAssetIds.has(asset.id)}
          size={STRIP_THUMB_SIZE}
        />
      ))}
    </ScrollView>
  );
}

/** 截图二级视图的三列网格。 */
export function ScreenshotsGrid({
  enabled,
  onToggleAsset,
  selectedAssetIds,
  busyAssetIds,
  disabled,
  contentWidth,
  testID,
}: ContextSheetMediaCallbacks & { enabled: boolean; contentWidth: number; testID?: string }) {
  const styles = useThemedStyles(makeMediaStyles);
  const { t } = useTranslation();
  const media = useContextSheetMediaAssets({ enabled, kind: 'screenshots' });
  const thumbSize = Math.floor((contentWidth - spacing.sm * (GRID_COLUMNS - 1)) / GRID_COLUMNS);

  if (media.status === 'denied') {
    return (
      <PermissionHint
        onRequest={media.requestPermission}
        testID={testID ? `${testID}.permission` : undefined}
      />
    );
  }
  if (media.status === 'unavailable' || (media.status === 'ready' && media.assets.length === 0)) {
    return <Text style={styles.emptyText}>{t('interaction.contextSheet.noScreenshots')}</Text>;
  }
  const rows: ContextSheetMediaAsset[][] = [];
  for (let i = 0; i < media.assets.length; i += GRID_COLUMNS) {
    rows.push(media.assets.slice(i, i + GRID_COLUMNS));
  }
  return (
    <View style={styles.grid} testID={testID}>
      {rows.map((row) => (
        <View key={row[0]?.id} style={styles.gridRow}>
          {row.map((asset) => (
            <MediaThumb
              asset={asset}
              busy={busyAssetIds?.has(asset.id) ?? false}
              disabled={disabled || selectedAssetIds.has(asset.id) || busyAssetIds?.has(asset.id)}
              key={asset.id}
              onPress={() => onToggleAsset(asset)}
                  selected={selectedAssetIds.has(asset.id)}
              size={thumbSize}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function MediaThumb({
  asset,
  busy,
  disabled,
  onPress,
  onToggleSelect,
  pendingIndex,
  selected,
  size,
}: {
  asset: ContextSheetMediaAsset;
  busy: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** 提供则显示选择圈(多选入口)。 */
  onToggleSelect?: () => void;
  /** 待选序号(从 1 起);与 selected(已附加勾选)互斥展示。 */
  pendingIndex?: number;
  selected: boolean;
  size: number;
}) {
  const styles = useThemedStyles(makeMediaStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const accessibilityLabel = t('interaction.contextSheet.mediaSelect', { name: asset.filename });
  const inactive = !!disabled || busy;
  const picked = pendingIndex !== undefined;
  return (
    // 照片与选择圈是并列的两个点按目标,不嵌套:圈在上层只占右上角,其余都是照片本身。
    <View style={[styles.thumb, { height: size, width: size }]}>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive, selected: selected || picked }}
        disabled={inactive}
        onPress={onPress}
        style={({ pressed }) => [styles.thumbImage, pressed && styles.thumbPressed]}
        testID={`contextSheet.mediaThumb.${asset.id}`}
      >
        <Image contentFit="cover" recyclingKey={asset.id} source={{ uri: asset.uri }} style={styles.thumbImage} transition={0} />
      </Pressable>
      {selected ? (
        <View pointerEvents="none" style={styles.thumbBadge}>
          <Check color={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.bold} />
        </View>
      ) : null}
      {busy ? (
        <View pointerEvents="none" style={styles.thumbBusyOverlay}>
          {/* 遮罩两种模式都是深色,转圈用恒白;ctaText 在深色模式反相为近黑,压在上面看不见。 */}
          <ActivityIndicator color={colors.swipeActionText} size="small" />
        </View>
      ) : null}
      {onToggleSelect && !selected && !busy ? (
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: picked, disabled: !!disabled }}
          disabled={disabled}
          onPress={onToggleSelect}
          style={({ pressed }) => [styles.thumbSelectHit, pressed && styles.thumbPressed]}
          testID={`contextSheet.mediaSelect.${asset.id}`}
        >
          {picked ? (
            <View style={styles.thumbBadge}>
              <Text style={styles.thumbBadgeText}>{pendingIndex}</Text>
            </View>
          ) : (
            <View style={styles.thumbSelectRing} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function PermissionHint({ onRequest, testID }: { onRequest: () => void; testID?: string }) {
  const styles = useThemedStyles(makeMediaStyles);
  const { t } = useTranslation();
  return (
    <View style={styles.permissionHint} testID={testID}>
      <Text style={styles.permissionText}>{t('interaction.contextSheet.photoPermissionHint')}</Text>
      <Pressable
        accessibilityLabel={t('interaction.contextSheet.enablePhotoPermission')}
        accessibilityRole="button"
        onPress={onRequest}
        style={({ pressed }) => [styles.permissionButton, pressed && styles.thumbPressed]}
      >
        <Text style={styles.permissionButtonText}>{t('interaction.contextSheet.enable')}</Text>
      </Pressable>
    </View>
  );
}

function makeMediaStyles(colors: ThemeColors) {
  return {
    strip: {
      marginTop: Platform.OS === 'ios' ? 0 : spacing.md,
    },
    stripContent: {
      gap: spacing.sm,
    },
    grid: {
      gap: spacing.sm,
      paddingTop: spacing.lg,
    },
    gridRow: {
      flexDirection: 'row' as const,
      gap: spacing.sm,
    },
    thumb: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.container,
      overflow: 'hidden' as const,
    },
    thumbPressed: {
      opacity: 0.7,
    },
    thumbImage: {
      height: '100%' as const,
      width: '100%' as const,
    },
    thumbBadge: {
      alignItems: 'center' as const,
      backgroundColor: colors.cta,
      borderRadius: radius.pill,
      height: 22,
      justifyContent: 'center' as const,
      position: 'absolute' as const,
      right: 6,
      top: 6,
      width: 22,
    },
    thumbSelectHit: {
      height: SELECT_HIT_SIZE,
      position: 'absolute' as const,
      right: 0,
      top: 0,
      width: SELECT_HIT_SIZE,
    },
    // 空选择圈压在任意照片上:恒深底 + 恒白描边(ctaText 在深色模式反相为近黑,不适合)。
    // 圈比 1px 描边略粗,在浅色照片上才认得出来。
    thumbSelectRing: {
      backgroundColor: colors.overlay,
      borderColor: colors.swipeActionText,
      borderRadius: radius.pill,
      borderWidth: 1.5,
      height: 22,
      position: 'absolute' as const,
      right: 6,
      top: 6,
      width: 22,
    },
    thumbBadgeText: {
      color: colors.ctaText,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.semibold,
      textAlign: 'center' as const,
    },
    thumbBusyOverlay: {
      alignItems: 'center' as const,
      backgroundColor: colors.overlay,
      bottom: 0,
      justifyContent: 'center' as const,
      left: 0,
      position: 'absolute' as const,
      right: 0,
      top: 0,
    },
    emptyText: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.xl,
      textAlign: 'center' as const,
    },
    permissionHint: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      gap: spacing.md,
      justifyContent: 'space-between' as const,
      paddingTop: spacing.md,
    },
    permissionText: {
      color: colors.textTertiary,
      flex: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    permissionButton: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: 6,
    },
    permissionButtonText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
    },
  };
}
