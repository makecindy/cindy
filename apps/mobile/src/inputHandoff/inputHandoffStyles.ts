import { StyleSheet } from "react-native";
import {
  fontWeight,
  lineHeight,
  monoFont,
  radius,
  spacing,
  typeScale,
  type ThemeColors,
} from "@/theme";

export const makeInputHandoffStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      gap: spacing.sm,
      padding: spacing.lg,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
    },
    // 代输入: optional live view of the window, below the step.
    liveView: {
      gap: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    // 代输入：设备码登录，代码与在本设备打开
    deviceCode: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceChip,
    },
    // 大数字：设备码本身
    deviceCodeText: {
      fontFamily: monoFont,
      fontSize: typeScale.headline,
      lineHeight: lineHeight.headline,
      fontWeight: fontWeight.semibold,
      letterSpacing: 2,
      color: colors.textPrimary,
    },
    row: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    // 列表 / 卡片标题
    title: {
      fontSize: typeScale.subtitle,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    // 行标题、选项
    label: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    // 次级正文
    body: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    // 时间、计数、状态词
    meta: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    // 说明、提示、报错
    note: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    warning: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderLeftWidth: 2,
      borderLeftColor: colors.warningFg,
      paddingLeft: spacing.sm,
    },
    mono: {
      fontFamily: monoFont,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    input: {
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
      paddingHorizontal: spacing.md,
      minHeight: 44,
    },
    option: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
    },
    optionSelected: {
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceChip,
    },
    // 低调的文字入口（看画面），保留 44pt 点击高度
    quietLink: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md },
    quietRow: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap" },
    // 代输入条：贴在输入框上方的一行（图标 + 用途 + 位置，右侧「填写」「跳过」）
    strip: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
    },
    stripRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    stripIcon: {
      width: 36,
      height: 36,
      borderRadius: radius.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceChip,
    },
    stripText: { flex: 1, minWidth: 0, gap: 2 },
    stripActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    stripStatus: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    stripStatusText: { flexShrink: 1 },
    // 位置行：锁 + 站点（或应用名）
    place: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minWidth: 0 },
    placeText: {
      flexShrink: 1,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    // 代输入表单（非 iOS 的底部面板）
    sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
    sheetPanel: {
      gap: spacing.lg,
      paddingTop: spacing.xl,
      paddingHorizontal: spacing.xl,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      backgroundColor: colors.surfaceElevated,
    },
    sheetHeader: { alignItems: "center", gap: spacing.sm },
    sheetIcon: {
      width: 56,
      height: 56,
      borderRadius: radius.container,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surfaceChip,
    },
    sheetTitle: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
      textAlign: "center",
    },
    sheetNote: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
      textAlign: "center",
    },
    sheetButtons: { gap: spacing.xs },
    // 页面上的报错（黑白系文字，语义由文案承担）
    error: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.errorText,
    },
    fieldLabel: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
      color: colors.textSecondary,
    },
    field: { gap: spacing.xs },
    stack: { gap: spacing.md },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    options: { maxHeight: 264 },
    // 代输入画面：整宽、按截图比例，点按位置按比例换算
    picture: {
      width: "100%",
      overflow: "hidden",
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceChip,
    },
    pictureDisabled: { opacity: 0.6 },
    // 扫码登录：电脑上的二维码，居中、正方形
    qrWrap: { alignItems: "center" },
    qrCode: {
      overflow: "hidden",
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sheetActionBorder,
      backgroundColor: colors.sheetActionSurface,
    },
    qrPlaceholder: {
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      padding: spacing.lg,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sheetActionBorder,
      backgroundColor: colors.sheetActionSurface,
    },
    centered: { textAlign: "center" },
    pictureImage: { width: "100%", height: "100%" },
  });
