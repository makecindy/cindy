/**
 * Context 面板的媒体视图:最近照片横向条(主视图顶部)+ 截图网格(二级视图)。
 *
 * 两者共用 useContextSheetMediaAssets 加载资产,点选走页面注入的 onToggleAsset
 * (页面负责 getAssetInfoAsync 换 localUri → 原生直传既有 presign→OSS 链路,或移除已附加项)。
 * 选中态由页面传入 selectedAssetIds(assetId ↔ 附件映射的真相在页面)。
 */
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
// RN 的 Image 在新架构下不支持 ph:// 相册 URI(facebook/react-native#36136),
// 缩略图走 expo-image:原生支持 ph://,且按视图尺寸解码,不会整张原图进内存。
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  useContextSheetMediaAssets,
  type ContextSheetMediaAsset,
} from '@/session/useContextSheetMediaAssets';

const STRIP_THUMB_SIZE = 84;
const GRID_COLUMNS = 3;

export interface ContextSheetMediaCallbacks {
  /** 点选资产:已附加 → 移除;待选 → 取消;其余 → 加入待选(由底部「加入对话」统一提交)。页面实现。 */
  onToggleAsset: (asset: ContextSheetMediaAsset) => void;
  /** 已附加为附件的 assetId 集(展示勾选角标)。 */
  selectedAssetIds: ReadonlySet<string>;
  /** 待选资产 assetId → 选中序号(从 1 起,展示数字角标,对照 Cursor)。 */
  pendingOrder?: ReadonlyMap<string, number>;
  /** 正在上传中的 assetId 集(对应格子显示 spinner 并禁点;其余照常可选——上传已后台并发,不再整面板锁定)。 */
  busyAssetIds?: ReadonlySet<string>;
  disabled?: boolean;
}

/** 主视图顶部的最近照片横向条(对照设计稿 PhotoStrip)。 */
export function RecentPhotosStrip({
  enabled,
  onToggleAsset,
  selectedAssetIds,
  pendingOrder,
  busyAssetIds,
  disabled,
  testID,
}: ContextSheetMediaCallbacks & { enabled: boolean; testID?: string }) {
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
          disabled={disabled || busyAssetIds?.has(asset.id)}
          key={asset.id}
          onPress={() => onToggleAsset(asset)}
          pendingIndex={pendingOrder?.get(asset.id)}
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
  pendingOrder,
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
              disabled={disabled || busyAssetIds?.has(asset.id)}
              key={asset.id}
              onPress={() => onToggleAsset(asset)}
              pendingIndex={pendingOrder?.get(asset.id)}
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
  pendingIndex,
  selected,
  size,
}: {
  asset: ContextSheetMediaAsset;
  busy: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** 待选序号(从 1 起);与 selected(已附加勾选)互斥展示。 */
  pendingIndex?: number;
  selected: boolean;
  size: number;
}) {
  const styles = useThemedStyles(makeMediaStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const accessibilityLabel = selected
    ? t('interaction.contextSheet.mediaRemove', { name: asset.filename })
    : pendingIndex
      ? t('interaction.contextSheet.mediaDeselect', { name: asset.filename })
      : t('interaction.contextSheet.mediaSelect', { name: asset.filename });
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, selected: selected || pendingIndex !== undefined }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.thumb,
        { height: size, width: size },
        pressed && styles.thumbPressed,
      ]}
      testID={`contextSheet.mediaThumb.${asset.id}`}
    >
      <Image contentFit="cover" recyclingKey={asset.id} source={{ uri: asset.uri }} style={styles.thumbImage} transition={0} />
      {selected ? (
        <View style={styles.thumbBadge}>
          <Check color={colors.ctaText} size={iconSize.xs} strokeWidth={iconStroke.bold} />
        </View>
      ) : pendingIndex ? (
        <View style={styles.thumbBadge}>
          <Text style={styles.thumbBadgeText}>{pendingIndex}</Text>
        </View>
      ) : null}
      {busy ? (
        <View style={styles.thumbBusyOverlay}>
          <ActivityIndicator color={colors.ctaText} size="small" />
        </View>
      ) : null}
    </Pressable>
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
      marginTop: spacing.md,
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
    thumbBadgeText: {
      color: colors.ctaText,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.semibold,
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
      fontWeight: fontWeight.medium,
    },
  };
}
