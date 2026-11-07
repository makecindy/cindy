import { Host } from "@expo/ui";
import {
  Button,
  Image,
  Label,
  Menu,
  RNHostView,
  Section,
  Text,
  Toggle,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  disabled,
  menuActionDismissBehavior,
  menuIndicator,
  menuOrder,
  menuStyle,
} from "@expo/ui/swift-ui/modifiers";
import type { ComponentProps, ReactNode } from "react";
import { View } from "react-native";
import type { NativePullDownAction } from "@/platform/chrome/NativePullDownMenu";
import { useNativeMenuReminderImage } from "@/platform/chrome/useNativeMenuReminderImage";
import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, navigationChrome, useTheme } from "@/theme";
import type { HomeDisplayMenuProps } from "./HomeDisplayMenu";

/** Sidebar-local native menu. MenuView's Fabric bridge only transports one
 * child level; the home model includes inline sections and deeper filters.
 * SwiftUI preserves that tree without changing the native toolbar or model. */
export function HomeDisplayMenu(props: HomeDisplayMenuProps) {
  const { colors, mode } = useTheme();
  const reminderImage = useNativeMenuReminderImage(true);
  const size = navigationChrome.target;
  const glassStyle = useNativeGlassButtonStyle({ shape: "circle" });
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      style={{ width: size, height: size }}
    >
      <Menu
        testID="home.displaySettingsButton"
        label={
          <RNHostView matchContents>
            {/* Only artwork in the label: Menu owns the glass and activation. */}
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              collapsable={false}
              style={{
                width: iconSize.action,
                height: iconSize.action,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {props.children}
            </View>
          </RNHostView>
        }
        modifiers={[
          menuStyle("button"),
          menuIndicator("hidden"),
          ...glassStyle,
          menuOrder("fixed"),
          accessibilityLabel(props.accessibilityLabel),
        ]}
      >
        {menuItems(props.actions, props.onAction, reminderImage)}
      </Menu>
    </Host>
  );
}

function menuItems(
  actions: readonly NativePullDownAction[],
  onAction: (id: string) => void,
  reminderImage: string | undefined,
): ReactNode {
  return actions.map((action) => {
    const modifiers: NonNullable<ComponentProps<typeof Button>["modifiers"]> = [
      disabled(!!action.disabled),
    ];
    const testID = `home.displayMenu.${action.id}`;
    const label = (
      <Label
        title={action.title}
        icon={
          action.filterReminder && reminderImage ? (
            <Image uiImage={`file://${encodeURI(reminderImage)}`} />
          ) : action.image ? (
            <Image
              systemName={
                action.image as ComponentProps<typeof Image>["systemName"]
              }
            />
          ) : undefined
        }
      />
    );
    if (action.subactions?.length) {
      const children = menuItems(action.subactions, onAction, reminderImage);
      return action.displayInline ? (
        <Section
          key={action.id}
          title={action.title || undefined}
          modifiers={modifiers}
        >
          {children}
        </Section>
      ) : (
        <Menu
          key={action.id}
          label={label}
          modifiers={modifiers}
          testID={testID}
        >
          {children}
        </Menu>
      );
    }
    modifiers.push(
      menuActionDismissBehavior(action.keepPresented ? "disabled" : "enabled"),
    );
    const select = () => {
      if (!action.disabled) onAction(action.id);
    };
    // Native Toggle supplies the menu checkmark; keep the action model as the
    // source of truth after selection (radio choices and multi-select alike).
    const content = (
      <>
        {label}
        {action.subtitle ? <Text>{action.subtitle}</Text> : null}
      </>
    );
    return action.state !== undefined ? (
      <Toggle
        key={action.id}
        isOn={action.state === "on"}
        onIsOnChange={select}
        modifiers={modifiers}
        testID={testID}
      >
        {content}
      </Toggle>
    ) : (
      <Button
        key={action.id}
        onPress={select}
        role={action.destructive ? "destructive" : undefined}
        modifiers={modifiers}
        testID={testID}
      >
        {content}
      </Button>
    );
  });
}
