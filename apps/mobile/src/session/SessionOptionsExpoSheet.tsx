/**
 * 左滑「选项」:iOS 用 Expo UI BottomSheet + List;Android 用 SessionActionSheet。
 *
 * iOS 直接用 `@expo/ui/swift-ui` 的 BottomSheet 而非通用 `@expo/ui` 封装:通用封装只把
 * onIsPresentedChange(false) 转成 onDismiss,而原生只在**用户**下拉 / 点背板时派发它;
 * 点菜单项后由 JS 把 isPresented 置 false 属于程序化关闭,不会回调。删除 / 重命名的
 * 后续弹窗都挂在 onClosed 上等 Sheet 卸载后再 present(useSessionListActions),没有
 * 回调就永远不弹。swift-ui 层的 onDismiss 对应 SwiftUI `.sheet(onDismiss:)`,两种关闭
 * 都在 Sheet 完全消失后触发,才是 onClosed 的正确挂点。
 */
import { Column, Host, List, ListItem, Text } from "@expo/ui";
import { BottomSheet, Group } from "@expo/ui/swift-ui";
import {
  frame,
  padding,
  presentationDragIndicator,
} from "@expo/ui/swift-ui/modifiers";
import { Platform } from "react-native";
import { SessionActionSheet } from "@/session/SessionActionSheet";
import {
  buildSessionActionMenu,
  type SessionSwipeAction,
} from "@/session/swipeRowRegistry";
import { useTheme } from "@/theme";

type SessionOptionsProps = {
  onAction(action: SessionSwipeAction): void;
  onClose(): void;
  onClosed?(): void;
  pinnedAt: string | null | undefined;
  status?: string | null;
  visible: boolean;
};

export function SessionOptionsPresenter(props: SessionOptionsProps) {
  if (Platform.OS !== "ios") {
    return <SessionActionSheet {...props} />;
  }
  return <SessionOptionsExpoSheet {...props} />;
}

// 与通用 BottomSheet 封装相同的内容边距 / 顶对齐 / 把手,fitToContents 自适应菜单高度。
const SHEET_CONTENT_MODIFIERS = [
  frame({ maxWidth: Infinity, alignment: "topLeading" }),
  padding({ top: 16, bottom: 0, leading: 16, trailing: 16 }),
  presentationDragIndicator("visible"),
];

function SessionOptionsExpoSheet({
  onAction,
  onClose,
  onClosed,
  pinnedAt,
  status,
  visible,
}: SessionOptionsProps) {
  const { colors } = useTheme();
  const menu = buildSessionActionMenu(pinnedAt, status);
  const regular = menu.filter((item) => item.destructive !== true);
  const destructive = menu.filter((item) => item.destructive === true);

  return (
    <Host pointerEvents="none" style={{ position: "absolute" }}>
      <BottomSheet
        fitToContents
        isPresented={visible}
        onDismiss={() => {
          onClosed?.();
        }}
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
        testID="home.sessionActions"
      >
        <Group modifiers={SHEET_CONTENT_MODIFIERS}>
          <Column>
            <List>
              {regular.map((item) => (
                <ListItem
                  key={item.action}
                  onPress={() => onAction(item.action)}
                  testID={`home.sessionActions.${item.action}`}
                >
                  {item.label}
                </ListItem>
              ))}
            </List>
            <List>
              {destructive.map((item) => (
                <ListItem
                  key={item.action}
                  onPress={() => onAction(item.action)}
                  testID={`home.sessionActions.${item.action}`}
                >
                  <Text textStyle={{ color: colors.destructive }}>
                    {item.label}
                  </Text>
                </ListItem>
              ))}
            </List>
          </Column>
        </Group>
      </BottomSheet>
    </Host>
  );
}
