import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderPlus,
  Laptop,
  MessageCircle,
} from "lucide-react-native";
import { Text } from "@/components/AppText";
import { NewTaskSelectionRow } from "@/session/NewTaskSelectionRow";
import { NativePullDownMenu, NativeSwitch } from "@/platform/chrome";
import { iconSize, lineHeight, spacing, typeScale, useTheme } from "@/theme";
import { SheetModal } from "./SheetModal";
import { SheetSurface } from "./SheetSurface";
import { ContextSheetFooterButton } from "./ContextSheet";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "./contextSheetModel";
import { newSessionText } from "./newSessionMessages";
import type { NewTaskSelectionSheetProps } from "./NewTaskSelectionSheet";

/** Same remote callbacks as iOS; the UI never reads the phone's local filesystem. */
export function NewTaskSelectionSheet(p: NewTaskSelectionSheetProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const browsing = p.page === "directory";
  const nativePresentation = useRef(false);
  // Keep the presentation kind through the closing animation, when page becomes null.
  if (p.page !== null) nativePresentation.current = p.page === "device";
  const unavailable = p.busy || p.loading;
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  useEffect(() => setSnap(browsing ? "full" : "half"), [p.page, browsing]);
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        screenHeight: height,
        safeAreaTopInset: insets.top,
      }),
    [height, insets.top],
  );
  const icon = (Icon: typeof Folder) => (
    <Icon size={iconSize.lg} color={colors.textSecondary} />
  );
  const title = t(
    p.page === "device"
      ? "session.new.selectControlledDevice"
      : browsing
        ? "session.new.chooseOtherFolder"
        : "session.new.selectWorkspace",
  );
  return (
    <SheetModal
      visible={p.page !== null}
      nativePresentation={nativePresentation.current}
      onBackdropPress={p.onClose}
      onClosed={p.onClosed}
      onRequestClose={browsing ? p.onBack : p.onClose}
    >
      <SheetSurface
        title={title}
        onClose={p.onClose}
        onBack={browsing ? p.onBack : undefined}
        heights={heights}
        snap={snap}
        onSnapChange={setSnap}
        bottomInset={insets.bottom}
        testID="newSession.selectionSheet"
        footer={
          browsing ? (
            <ContextSheetFooterButton
              label={t("session.new.useCurrent")}
              disabled={unavailable || !p.path || !!p.error}
              onPress={() => {
                if (p.path && !unavailable && !p.error) p.onChoose(p.path);
              }}
              testID="newSession.remoteBrowseSelectCurrent"
            />
          ) : undefined
        }
      >
        {p.page === "device" ? (
          p.devices.map((device) => (
            <NewTaskSelectionRow
              key={device.deviceId}
              title={device.name || device.deviceId}
              leading={icon(Laptop)}
              selected={device.deviceId === p.selectedDeviceId}
              disabled={p.busy}
              onPress={() => p.onDevice(device.deviceId)}
              testID="newSession.deviceOption"
            />
          ))
        ) : p.page === "workspace" ? (
          <>
            <NewTaskSelectionRow
              title={t("session.new.workspaceDialogue")}
              leading={icon(MessageCircle)}
              selected={p.workspaceKind === "dialogue"}
              disabled={p.busy}
              onPress={p.onDialogue}
              testID="newSession.workspaceDialogueOption"
            />
            {p.workspaces.map((workspace) => (
              <NewTaskSelectionRow
                key={workspace.workingDir}
                title={workspace.title}
                subtitle={workspace.workingDir}
                leading={icon(Folder)}
                selected={
                  p.workspaceKind === "project" &&
                  p.workingDir.trim() === workspace.workingDir
                }
                disabled={p.busy}
                onPress={() => p.onProject(workspace.workingDir)}
                testID="newSession.workspaceProjectOption"
              />
            ))}
            <NewTaskSelectionRow
              title={t("session.new.chooseOtherFolder")}
              leading={icon(FolderPlus)}
              trailing={icon(ChevronRight)}
              disabled={p.busy}
              onPress={p.onBrowse}
              testID="newSession.workspaceBrowseOption"
            />
          </>
        ) : browsing ? (
          <>
            <Text
              testID="newSession.remoteBrowseCurrentPath"
              style={{
                color: colors.textSecondary,
                fontSize: typeScale.footnote,
                lineHeight: lineHeight.caption,
                paddingVertical: spacing.sm,
              }}
            >
              {p.path || t("session.new.readingRemoteDir")}
            </Text>
            <NewTaskSelectionRow
              title={t("session.new.parentDir")}
              leading={icon(ArrowUp)}
              disabled={!p.parent || unavailable}
              onPress={() => {
                if (p.parent) p.onEnter(p.parent);
              }}
              testID="newSession.remoteBrowseParentButton"
            />
            {p.drives.length ? (
              <NativePullDownMenu
                accessibilityLabel={[
                  t("session.new.drive"),
                  p.drives.find((drive) => drive.current)?.name,
                ]
                  .filter(Boolean)
                  .join(", ")}
                disabled={unavailable}
                actions={p.drives.map((drive) => ({
                  id: drive.path,
                  title: drive.name,
                  state: drive.current ? "on" : "off",
                }))}
                onAction={(path) => {
                  if (!unavailable) p.onEnter(path);
                }}
                testID="newSession.remoteBrowseDrivePicker"
              >
                <NewTaskSelectionRow
                  title={t("session.new.drive")}
                  value={p.drives.find((drive) => drive.current)?.name}
                  onPress={() => {}}
                />
              </NativePullDownMenu>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: spacing.md,
              }}
            >
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typeScale.body,
                  lineHeight: lineHeight.body,
                }}
              >
                {newSessionText("showHiddenDirectories")}
              </Text>
              <NativeSwitch
                accessibilityLabel={newSessionText("showHiddenDirectories")}
                disabled={p.busy}
                value={p.showHidden}
                onValueChange={p.onShowHidden}
                testID="newSession.remoteBrowseShowHidden"
              />
            </View>
            {p.loading ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : null}
            {p.error ? (
              <Text
                style={{
                  color: colors.errorText,
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                }}
              >
                {p.error}
              </Text>
            ) : null}
            {!p.loading && !p.error && !p.entries.length ? (
              <Text
                style={{
                  color: colors.textSecondary,
                  fontSize: typeScale.footnote,
                  lineHeight: lineHeight.caption,
                }}
              >
                {newSessionText("emptyDirectory")}
              </Text>
            ) : null}
            {p.entries.map((entry) => (
              <NewTaskSelectionRow
                key={entry.path}
                title={entry.name}
                leading={icon(Folder)}
                trailing={icon(ChevronRight)}
                disabled={unavailable}
                onPress={() => p.onEnter(entry.path)}
                testID="newSession.remoteBrowseEnterEntry"
              />
            ))}
          </>
        ) : null}
      </SheetSurface>
    </SheetModal>
  );
}
