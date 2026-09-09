/**
 * 首页顶栏底(Android / 无系统导航栏时)。
 * 跟列表同色;iOS 首页改走系统 UINavigationBar 后不再包这一层。
 * 上滑时改为半透明 surface + 模糊,下面内容能透一点,颜色仍是列表灰。
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { useTheme } from '@/theme';

export function HomeChromeFrost({
  children,
  disabled = false,
  visible,
}: {
  children: ReactNode;
  disabled?: boolean;
  visible: boolean;
}) {
  const { colors } = useTheme();

  if (disabled) return children;

  return (
    <View>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {visible ? (
          <BlurBackdrop intensity={50} overlayColor={colors.surfaceTranslucent} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />
        )}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    zIndex: 1,
  },
});
