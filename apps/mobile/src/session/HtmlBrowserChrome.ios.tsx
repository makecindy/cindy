import { Host } from "@expo/ui";
import {
  Button,
  Divider,
  HStack,
  Image,
  Menu,
  ProgressView,
  Section,
  Text as NativeText,
  TextField,
  useNativeState,
  type TextFieldRef,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  autocorrectionDisabled,
  background,
  buttonStyle,
  controlSize,
  disabled,
  font,
  frame,
  glassEffect,
  labelStyle,
  lineLimit,
  menuOrder,
  keyboardType,
  onSubmit,
  submitLabel,
  textInputAutocapitalization,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { Alert, StyleSheet, View } from "react-native";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { iconSize, lineHeight, radius, spacing, typeScale, useTheme } from "@/theme";
import { useLiquidGlassAvailable } from "./useLiquidGlassAvailable";
import {
  HTML_BROWSER_CONTROL_SIZE as size,
  type HtmlBrowserChromeProps,
} from "./HtmlBrowserChrome.types";

/** Native SwiftUI controls float above the WebView; the empty space passes touches through. */
export function HtmlBrowserChrome(p: HtmlBrowserChromeProps) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const glass = useLiquidGlassAvailable();
  const [editing, setEditing] = useState(false);
  const addressText = useNativeState(p.address);
  const addressRef = useRef<TextFieldRef>(null);
  const beginEditing = () => { addressText.set(p.address); setEditing(true); };
  const submitAddress = () => { if (p.onNavigate(addressText.get())) setEditing(false); };
  const showFileInfo = () => Alert.alert(p.title, p.path);
  // Size the visible glass itself, not an outer frame around a system-sized label.
  // Menu and Button have different intrinsic sizes (especially ellipsis vs share).
  const circle = [
    buttonStyle("plain"),
    frame({ width: size, height: size }),
    glass
      ? glassEffect({
          glass: { variant: "regular", interactive: true },
          shape: "circle",
        })
      : background(colors.surfaceElevated, shapes.circle()),
  ];
  const icon = [
    labelStyle("iconOnly"),
    buttonStyle("borderless"),
    controlSize("large"),
    frame({ width: size, height: size }),
  ];
  const capsule = glass
    ? glassEffect({ glass: { variant: "regular" }, shape: "capsule" })
    : background(colors.surfaceElevated, shapes.capsule());
  const host = {
    colorScheme: mode,
    seedColor: colors.textPrimary,
    ignoreSafeArea: "all" as const,
  };
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: p.top,
          left: p.left,
          right: p.right,
          flexDirection: "row",
          gap: spacing.sm,
        }}
      >
        <Host {...host} style={{ width: size, height: size }}>
          <Button
            onPress={p.onClose}
            testID="filePreview.done"
            modifiers={[...circle, accessibilityLabel(t("files.preview.done"))]}
          >
            <Image
              systemName="xmark"
              size={iconSize.lg}
              modifiers={[frame({ width: size, height: size })]}
            />
          </Button>
        </Host>
        <Host {...host} style={{ flex: 1, minWidth: 0, height: size }}>
          <HStack
            spacing={0}
            modifiers={[frame({ maxWidth: Infinity, height: size }), capsule]}
          >
            {editing ? <TextField
              ref={addressRef}
              text={addressText}
              autoFocus
              onFocusChange={(focused) => {
                if (focused) void addressRef.current?.setSelection(0, addressText.get().length);
              }}
              testID="filePreview.browser.addressInput"
              modifiers={[
                keyboardType("url"), autocorrectionDisabled(), textInputAutocapitalization("never"),
                submitLabel("go"), onSubmit(submitAddress),
                accessibilityLabel(t("files.preview.browserAddress")),
                font({ size: typeScale.body }), padding({ leading: spacing.lg }),
                frame({ maxWidth: Infinity, height: size }),
              ]}
            /> : <Button
              onPress={beginEditing}
              testID="filePreview.browser.editAddress"
              modifiers={[
                buttonStyle("plain"),
                frame({ maxWidth: Infinity, height: size }),
                accessibilityLabel(
                  `${t("files.preview.browserAddress")}: ${p.address}`,
                ),
              ]}
            >
              <HStack
                spacing={spacing.sm}
                modifiers={[
                  padding({ leading: spacing.lg }),
                  frame({
                    maxWidth: Infinity,
                    height: size,
                    alignment: "leading",
                  }),
                ]}
              >
                <Image
                  systemName={
                    p.website ? "globe" : p.source ? "chevron.left.forwardslash.chevron.right" : "doc"
                  }
                  size={iconSize.md}
                />
                <NativeText
                  testID="filePreview.title"
                  modifiers={[
                    font({ size: typeScale.footnote }),
                    lineLimit(1),
                    frame({ maxWidth: Infinity, alignment: "leading" }),
                  ]}
                >
                  {p.title}
                </NativeText>
              </HStack>
            </Button>}
            {editing ? <Button
              label={t("files.preview.browserCancelAddress")}
              systemImage="xmark"
              onPress={() => setEditing(false)}
              modifiers={icon}
              testID="filePreview.browser.cancelAddress"
            /> : p.loading ? (
              <ProgressView
                modifiers={[
                  frame({ width: size, height: size }),
                  accessibilityLabel(t("files.preview.fetchingHtmlResources")),
                ]}
              />
            ) : (
              <Button
                label={t("files.preview.htmlReload")}
                systemImage="arrow.clockwise"
                onPress={p.onReload}
                testID="filePreview.browser.reload"
                modifiers={[...icon, disabled(p.source || p.loading)]}
              />
            )}
          </HStack>
        </Host>
      </View>
      {p.notice ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: p.bottom + size + spacing.sm,
            left: p.left,
            right: p.right,
            alignItems: "center",
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            testID="filePreview.notice"
            style={{
              color: colors.textPrimary,
              backgroundColor: colors.surfaceElevated,
              padding: spacing.sm,
              borderRadius: radius.pill,
              fontSize: typeScale.caption,
              lineHeight: lineHeight.caption,
            }}
          >
            {p.notice}
          </Text>
        </View>
      ) : null}
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          bottom: p.bottom,
          left: p.left,
          right: p.right,
          flexDirection: "row",
          gap: spacing.md,
        }}
      >
        <Host {...host} style={{ width: size * 2, height: size }}>
          <HStack spacing={0} modifiers={[capsule]}>
            <Button
              label={t("files.preview.browserBack")}
              systemImage="chevron.backward"
              onPress={p.onBack}
              testID="filePreview.browser.back"
              modifiers={[...icon, disabled(!p.canGoBack)]}
            />
            <Button
              label={t("files.preview.browserForward")}
              systemImage="chevron.forward"
              onPress={p.onForward}
              testID="filePreview.browser.forward"
              modifiers={[...icon, disabled(!p.canGoForward)]}
            />
          </HStack>
        </Host>
        <View pointerEvents="none" style={{ flex: 1 }} />
        <Host {...host} style={{ width: size, height: size }}>
          <Button
            onPress={p.onShare}
            testID="filePreview.share"
            modifiers={[
              ...circle,
              disabled(p.busy),
              accessibilityLabel(t("files.preview.a11yShare")),
            ]}
          >
            <Image
              systemName="square.and.arrow.up"
              size={iconSize.lg}
              modifiers={[frame({ width: size, height: size })]}
            />
          </Button>
        </Host>
        <Host {...host} style={{ width: size, height: size }}>
          <Menu
            label={
              <Image
                systemName="ellipsis"
                size={iconSize.lg}
                modifiers={[frame({ width: size, height: size })]}
              />
            }
            testID="filePreview.browser.more"
            modifiers={[
              ...circle,
              menuOrder("fixed"),
              accessibilityLabel(t("files.preview.browserMore")),
            ]}
          >
            {!p.website && <Section title={p.title}>
              <Button
                label={t("files.preview.browserFileInfo")}
                systemImage="doc"
                onPress={showFileInfo}
              />
            </Section>}
            <Button
              label={t(
                p.website ? "files.preview.browserReturnToFile" : p.source
                  ? "files.preview.browserShowPage"
                  : "files.preview.browserShowSource",
              )}
              systemImage="chevron.left.forwardslash.chevron.right"
              onPress={p.onToggleSource}
              testID="filePreview.browser.source"
            />
            <Divider />
            <Button
              label={t(p.website ? "files.preview.browserCopyAddress" : "files.preview.copyPath")}
              systemImage="doc.on.doc"
              onPress={p.onCopyPath}
              testID="filePreview.copyPath"
              modifiers={[disabled(p.busy)]}
            />
            {!p.website && <Button
              label={t("files.preview.browserAddToTask")}
              systemImage="text.bubble"
              onPress={p.onAddToTask}
              testID="filePreview.sendToSession"
              modifiers={[disabled(p.busy)]}
            />}
          </Menu>
        </Host>
      </View>
    </View>
  );
}
