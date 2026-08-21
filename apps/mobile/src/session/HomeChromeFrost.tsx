/**
 * 首页顶栏底。
 * 静止和上滑都用跟任务列表相同的 surface 色,不用系统玻璃默认的发白材质。
 * 上滑时改为半透明 surface + 模糊,下面内容能透一点,颜色仍是列表灰。
 */
import { StyleSheet, View } from 'react-native';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { useTheme } from '@/theme';

export function HomeChromeFrost({ visible }: { visible: boolean }) {
  const { colors } = useTheme();

  if (!visible) {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]}
      />
    );
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <BlurBackdrop intensity={50} overlayColor={colors.surfaceTranslucent} />
    </View>
  );
}
