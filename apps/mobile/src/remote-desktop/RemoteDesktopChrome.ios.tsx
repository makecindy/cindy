import type { ComponentProps } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Button,
  Group,
  HStack,
  Popover,
  RNHostView,
  Spacer,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityLabel,
  background,
  buttonStyle,
  contentShape,
  disabled,
  frame,
  glassEffect,
  padding,
  presentationDetents,
  presentationDragIndicator,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { Keyboard, SlidersHorizontal } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  fontWeight,
  iconSize,
  iconStroke,
  spacing,
  typeScale,
  useTheme,
} from "@/theme";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import { Text as AppText } from "@/components/AppText";
import { RemoteDesktopPanelButton } from "./RemoteDesktopPanelButton";
import { AllWindowsIcon, ShowDesktopIcon } from "./RemoteDesktopIcons";
import type {
  RemoteDesktopPanel as Panel,
  RemoteDesktopToolbar as Toolbar,
} from "./RemoteDesktopChrome";

// Four 44pt native hit targets with a 4pt inset inside one glass capsule.
const target = 44;
const inset = 4;
const breadth = target + inset * 2;
const length = target * 4 + inset * 2;

export function RemoteDesktopToolbar(props: ComponentProps<typeof Toolbar>) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const glass = useLiquidGlassAvailable();
  const actions = [
    {
      key: "allWindows",
      Icon: AllWindowsIcon,
      onPress: props.onWindows,
      disabled: !props.canControl,
      selected: false,
    },
    {
      key: "showDesktop",
      Icon: ShowDesktopIcon,
      onPress: props.onDesktop,
      disabled: !props.canControl,
      selected: false,
    },
    {
      key: "keyboard",
      Icon: Keyboard,
      onPress: props.onKeyboard,
      disabled: !props.canControl,
      selected: props.keyboard,
    },
    {
      key: "operations",
      Icon: SlidersHorizontal,
      onPress: props.onOperations,
      disabled: false,
      selected: props.operations,
    },
  ];
  const Stack = props.landscape ? VStack : HStack;
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      ignoreSafeArea="all"
      testID="remoteDesktop.toolbar"
      style={{
        width: props.landscape ? breadth : length,
        height: props.landscape ? length : breadth,
      }}
    >
      <Stack
        spacing={0}
        modifiers={[
          padding({ all: inset }),
          ...(glass
            ? [glassEffect({ glass: { variant: "regular" }, shape: "capsule" })]
            : [background(colors.surfaceElevated, shapes.capsule())]),
        ]}
      >
        {(props.landscape ? [...actions].reverse() : actions).map(
          ({ key, Icon, onPress, disabled: unavailable, selected }) => (
            <Button
              key={key}
              onPress={onPress}
              testID={`remoteDesktop.${key}`}
              modifiers={[
                buttonStyle("borderless"),
                disabled(unavailable),
                frame({ width: target, height: target }),
                ...(selected
                  ? [background(colors.surfaceChip, shapes.circle())]
                  : []),
                accessibilityElement("ignore"),
                accessibilityLabel(t(`remoteDesktop.${key}`)),
                accessibilityAddTraits(
                  selected ? ["isButton", "isSelected"] : ["isButton"],
                ),
              ]}
            >
              <VStack
                modifiers={[
                  frame({ width: target, height: target }),
                  contentShape(shapes.rectangle()),
                ]}
              >
                <RNHostView>
                  <View
                    pointerEvents="none"
                    style={{
                      flex: 1,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon
                      size={iconSize.action}
                      strokeWidth={iconStroke.regular}
                      color={colors.textPrimary}
                    />
                  </View>
                </RNHostView>
              </VStack>
            </Button>
          ),
        )}
      </Stack>
    </Host>
  );
}

export function RemoteDesktopPanel(props: ComponentProps<typeof Panel>) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const size = useWindowDimensions();
  const safe = useSafeAreaInsets();
  const visible = props.visible ?? true;
  const toolbarOnLeft = props.toolbarOnLeft ?? false;
  const railTop =
    safe.top + Math.max(0, (size.height - safe.top - safe.bottom - length) / 2);
  // Keep one RN surface for header and body. Changing SwiftUI siblings while
  // it is presented can detach the hosted content; page navigation belongs
  // inside the RN surface, while Sheet/Popover owns presentation only.
  const content = (
    <RNHostView>
      <View
        collapsable={false}
        style={{ flex: 1 }}
        testID="remoteDesktop.panelContentRoot"
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: spacing.md,
            gap: spacing.sm,
          }}
        >
          <View style={{ width: target, height: target }}>
            {props.onBack && (
              <RemoteDesktopPanelButton
                back
                label={t("remoteDesktop.back")}
                onPress={props.onBack}
              />
            )}
          </View>
          <View style={{ flex: 1, alignItems: "center" }}>
            <AppText
              accessibilityRole="header"
              style={{
                color: colors.textPrimary,
                fontSize: typeScale.body,
                fontWeight: fontWeight.semibold,
              }}
            >
              {props.title}
            </AppText>
            <AppText
              numberOfLines={1}
              style={{
                color: colors.textPrimary,
                fontSize: typeScale.caption,
              }}
            >
              {props.caption}
            </AppText>
          </View>
          <View style={{ width: target, height: target }} />
        </View>
        <ScrollView
          key={props.page}
          testID="remoteDesktop.panelScroll"
          style={{ flex: 1 }}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.lg,
            paddingBottom: spacing.lg + (props.landscape ? 0 : safe.bottom),
            gap: spacing.xl,
          }}
        >
          {props.children}
          {props.footer}
        </ScrollView>
      </View>
    </RNHostView>
  );
  const onPresented = (presented: boolean) => {
    if (!presented) props.onClose();
  };
  if (props.landscape)
    return (
      <Host
        key="popover"
        colorScheme={mode}
        seedColor={colors.textPrimary}
        ignoreSafeArea="all"
        pointerEvents="none"
        style={{
          position: "absolute",
          left: toolbarOnLeft ? spacing.lg + inset : undefined,
          right: toolbarOnLeft ? undefined : spacing.lg + inset,
          top: railTop + inset,
          width: target,
          height: target,
        }}
      >
        <Popover
          isPresented={visible}
          onIsPresentedChange={onPresented}
          attachmentAnchor={toolbarOnLeft ? "trailing" : "leading"}
          arrowEdge={toolbarOnLeft ? "leading" : "trailing"}
        >
          <Popover.Trigger>
            <Spacer modifiers={[frame({ width: target, height: target })]} />
          </Popover.Trigger>
          <Popover.Content>
            <Group
              modifiers={[
                frame({
                  width: Math.min(
                    360,
                    size.width - safe.left - safe.right - breadth - spacing.lg,
                  ),
                  height: Math.max(
                    target,
                    size.height - safe.top - safe.bottom - spacing.lg,
                  ),
                }),
              ]}
            >
              {content}
            </Group>
          </Popover.Content>
        </Popover>
      </Host>
    );
  return (
    <Host
      key="sheet"
      colorScheme={mode}
      seedColor={colors.textPrimary}
      pointerEvents="none"
      style={{ position: "absolute" }}
    >
      <BottomSheet isPresented={visible} onIsPresentedChange={onPresented}>
        <Group
          modifiers={[
            presentationDetents(["medium", "large"]),
            presentationDragIndicator("visible"),
          ]}
        >
          {content}
        </Group>
      </BottomSheet>
    </Host>
  );
}
