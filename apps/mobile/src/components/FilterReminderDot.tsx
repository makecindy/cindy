import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useThemedStyles, type ThemeColors } from "@/theme";
import { radius } from "@/theme/tokens";

/**
 * 筛选提醒点(DESIGN.md「筛选提醒点」,2026-10-20 登记):6pt 强调色小圆点,落在筛选 / 视图设置
 * 按钮的右上角,提醒「当前列表不是默认的进行中视图」。搜索栏的筛选钮有筛选条件生效时、首页
 * 「⋯」显示设置钮在查看「已归档」时共用它;大小与颜色只此一处,调用方只给相对宿主按钮的偏移。
 * 纯装饰:状态由按钮的无障碍名称 / 状态播报。宿主按钮须是定位容器。
 */
export function FilterReminderDot({ offset, testID }: { offset: StyleProp<ViewStyle>; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return <View pointerEvents="none" style={[styles.dot, offset]} testID={testID} />;
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    dot: {
      backgroundColor: colors.statusAccent,
      borderRadius: radius.pill,
      height: 6,
      position: "absolute",
      width: 6,
    },
  });
