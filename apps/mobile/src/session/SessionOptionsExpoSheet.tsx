/**
 * 左滑「选项」:iOS 用 Expo UI BottomSheet + List;Android 用 SessionActionSheet。
 */
import { BottomSheet, Column, Host, List, ListItem, Text } from "@expo/ui";
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
    <Host>
      <BottomSheet
        isPresented={visible}
        onDismiss={() => {
          onClose();
          onClosed?.();
        }}
        showDragIndicator
        testID="home.sessionActions"
      >
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
      </BottomSheet>
    </Host>
  );
}
