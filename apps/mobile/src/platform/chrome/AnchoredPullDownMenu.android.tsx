import {
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
  Host,
  RNHostView,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  fillMaxSize,
  padding,
  width,
  testID as nativeTestID,
} from "@expo/ui/jetpack-compose/modifiers";
import { Fragment, isValidElement, useState, type ComponentProps } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityProps,
} from "react-native";
import type { AnchoredPullDownMenu as CompatibleMenu } from "./AnchoredPullDownMenu";
import {
  buildPullDownMenuSections,
  resolvePullDownSubmenu,
} from "./pullDownMenuModel";
import { fontWeight, lineHeight, spacing, typeScale, useTheme } from "@/theme";
import { Text as AppText } from "@/components/AppText";
import type { NativePullDownAction } from "./NativePullDownMenu";

/** Compose's exported modifiers lack a tri-state semantic setter. Keep one RN
 * accessible row inside the native popup, rather than exposing a decorative
 * checkmark (or adding a second clickable checkbox beside the menu action). */
function CheckedMenuItem({
  action,
  onPress,
  testID,
}: {
  action: NativePullDownAction;
  onPress(): void;
  testID: string;
}) {
  const { colors } = useTheme();
  const color = action.disabled
    ? colors.textTertiary
    : action.destructive
      ? colors.destructive
      : colors.textPrimary;
  return (
    <RNHostView matchContents>
      <Pressable
        accessible
        accessibilityRole="menuitem"
        accessibilityLabel={[action.title, action.subtitle]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{
          checked: action.state === "mixed" ? "mixed" : action.state === "on",
          disabled: !!action.disabled,
        }}
        disabled={!!action.disabled}
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => ({
          width: 280,
          minHeight: 48,
          justifyContent: "center",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          backgroundColor: pressed ? colors.surfaceChip : "transparent",
        })}
      >
        <View
          importantForAccessibility="no-hide-descendants"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
          }}
        >
          <View style={{ flex: 1 }}>
            <AppText
              style={{
                color,
                fontSize: typeScale.body,
                lineHeight: lineHeight.body,
                fontWeight: action.disabled
                  ? fontWeight.regular
                  : fontWeight.medium,
              }}
            >
              {action.title}
            </AppText>
            {action.subtitle ? (
              <AppText
                style={{
                  color: action.disabled
                    ? colors.textTertiary
                    : colors.textSecondary,
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                }}
              >
                {action.subtitle}
              </AppText>
            ) : null}
          </View>
          {action.subactions?.length || action.state !== "off" ? (
            <AppText
              style={{
                color,
                fontSize: typeScale.body,
                lineHeight: lineHeight.body,
              }}
            >
              {action.subactions?.length
                ? "›"
                : action.state === "mixed"
                  ? "−"
                  : "✓"}
            </AppText>
          ) : null}
        </View>
      </Pressable>
    </RNHostView>
  );
}

/** Material owns popup placement, scrolling, focus and enter/exit animations. */
export function AnchoredPullDownMenu({
  actions,
  children,
  longPress,
  onAction,
  style,
  testID,
  accessibilityLabel,
}: ComponentProps<typeof CompatibleMenu>) {
  const { colors, mode } = useTheme();
  const [open, setOpen] = useState(false);
  // Lazily create the Compose tree, then reuse it for this trigger's lifetime.
  // Removing it on every close adds Fabric mount work to the next input frame
  // and cuts off Material's exit animation. The popup itself still closes.
  const [mounted, setMounted] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const child = isValidElement(children)
    ? (children.props as AccessibilityProps)
    : {};
  const submenu = resolvePullDownSubmenu(actions, path);
  const sections = buildPullDownMenuSections(submenu?.subactions ?? actions);
  const show = () => {
    setMounted(true);
    setPath([]);
    setOpen(true);
  };
  const back = () => setPath((current) => current.slice(0, -1));
  const choose = (action: NativePullDownAction) => {
    if (action.disabled) return;
    if (action.subactions?.length && !action.displayInline) {
      setPath((current) => [...current, action.id]);
      return;
    }
    if (!action.keepPresented) setOpen(false);
    onAction(action.id);
  };
  return (
    <View style={style}>
      <Pressable
        accessibilityLabel={accessibilityLabel ?? child.accessibilityLabel}
        accessibilityHint={child.accessibilityHint}
        accessibilityValue={child.accessibilityValue}
        accessibilityRole="button"
        accessibilityState={{ ...child.accessibilityState, expanded: open }}
        onPress={longPress ? undefined : show}
        onLongPress={longPress ? show : undefined}
        testID={testID}
      >
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
        >
          {children}
        </View>
      </Pressable>
      {mounted ? (
        // The anchor has no input of its own. RN must exclude the Host from
        // hit testing; Compose's popup receives input in its separate window.
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Host
            colorScheme={mode}
            seedColor={colors.textPrimary}
            style={StyleSheet.absoluteFill}
          >
            <DropdownMenu
              expanded={open}
              modifiers={[
                nativeTestID(testID ? `${testID}.menu` : "pullDownMenu"),
              ]}
              color={colors.surfaceElevated}
              onDismissRequest={() => setOpen(false)}
            >
              <DropdownMenu.Trigger>
                <Box modifiers={[fillMaxSize()]} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Items>
                {submenu ? (
                  <DropdownMenuItem onClick={back}>
                    <DropdownMenuItem.Text>
                      <Text
                        color={colors.textPrimary}
                        style={{
                          fontSize: typeScale.body,
                          lineHeight: lineHeight.body,
                        }}
                      >
                        ‹ {submenu.title}
                      </Text>
                    </DropdownMenuItem.Text>
                  </DropdownMenuItem>
                ) : null}
                {sections.map((section, index) => (
                  <Fragment key={section.key}>
                    {index > 0 || submenu ? (
                      <HorizontalDivider color={colors.border} />
                    ) : null}
                    {section.title ? (
                      <Text
                        color={colors.textSecondary}
                        modifiers={[
                          padding(
                            spacing.md,
                            spacing.sm,
                            spacing.md,
                            spacing.xs,
                          ),
                        ]}
                        style={{
                          fontSize: typeScale.footnote,
                          lineHeight: lineHeight.caption,
                        }}
                      >
                        {section.title}
                      </Text>
                    ) : null}
                    {section.rows.map((action) =>
                      action.state ? (
                        <CheckedMenuItem
                          key={action.id}
                          action={action}
                          onPress={() => choose(action)}
                          testID={`${testID ? `${testID}.menu` : "pullDownMenu"}.item.${action.id}`}
                        />
                      ) : (
                        <DropdownMenuItem
                          key={action.id}
                          enabled={!action.disabled}
                          modifiers={[
                            width(280),
                            nativeTestID(
                              `${testID ? `${testID}.menu` : "pullDownMenu"}.item.${action.id}`,
                            ),
                          ]}
                          elementColors={{
                            textColor: action.destructive
                              ? colors.destructive
                              : colors.textPrimary,
                            disabledTextColor: colors.textTertiary,
                          }}
                          onClick={() => choose(action)}
                        >
                          <DropdownMenuItem.Text>
                            <Column>
                              <Text
                                style={{
                                  fontSize: typeScale.body,
                                  lineHeight: lineHeight.body,
                                  fontWeight: fontWeight.regular,
                                }}
                              >
                                {action.title}
                              </Text>
                              {action.subtitle ? (
                                <Text
                                  color={colors.textSecondary}
                                  style={{
                                    fontSize: typeScale.footnote,
                                    lineHeight: lineHeight.caption,
                                  }}
                                >
                                  {action.subtitle}
                                </Text>
                              ) : null}
                            </Column>
                          </DropdownMenuItem.Text>
                          {action.subactions?.length ? (
                            <DropdownMenuItem.TrailingIcon>
                              <Text>›</Text>
                            </DropdownMenuItem.TrailingIcon>
                          ) : null}
                        </DropdownMenuItem>
                      ),
                    )}
                  </Fragment>
                ))}
              </DropdownMenu.Items>
            </DropdownMenu>
          </Host>
        </View>
      ) : null}
    </View>
  );
}
