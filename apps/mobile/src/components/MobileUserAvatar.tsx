import { Image, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, typeScale } from '@/theme/tokens';

/**
 * 账号头像(设置页头部、左侧抽屉、账号切换列表共用)。
 * - 有图:圆形裁切;
 * - 无图:取名称首字母(大写),同一套字重 600 + textPrimary,只随尺寸换字号档;
 * - 尺寸两档:`large`(56,设置页账号头部)与 `regular`(44,抽屉 / 列表行)。
 * 浮起面按规范带 1px 描边,不靠 surfaceElevated 的色差分层。
 */
export type MobileUserAvatarSize = 'large' | 'regular';

const AVATAR_DIMENSION: Record<MobileUserAvatarSize, number> = {
  large: 56,
  regular: 44,
};

function mobileUserAvatarInitial(name: string | null | undefined): string {
  // Whole code point, so a name starting with an emoji or astral character stays intact.
  return (Array.from(name?.trim() ?? '')[0] ?? '?').toUpperCase();
}

export function MobileUserAvatar({
  imageUrl,
  name,
  size = 'regular',
  testID,
}: {
  imageUrl?: string | null;
  name: string | null | undefined;
  size?: MobileUserAvatarSize;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const dimension = AVATAR_DIMENSION[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.avatar, { height: dimension, width: dimension }]}
      testID={testID}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={{ height: dimension, width: dimension }} />
      ) : (
        <Text style={size === 'large' ? styles.initialLarge : styles.initialRegular}>
          {mobileUserAvatarInitial(name)}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexShrink: 0,
      justifyContent: 'center',
      overflow: 'hidden',
    },
    initialLarge: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
    },
    initialRegular: {
      color: colors.textPrimary,
      fontSize: typeScale.subtitle,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.subtitle,
    },
  });
