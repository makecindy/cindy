import { Platform, View, ScrollView, ActivityIndicator } from "react-native";
import { SheetModal } from "./SheetModal";
import { NewTaskSelectionRow } from "./NewTaskSelectionRow";
import { useEffect, useState } from "react";
import { TextInput } from "@/components/AppText";
import { useTheme, typeScale, lineHeight, spacing, radius } from "@/theme";
import { useTranslation } from "react-i18next";
import { useRemoteSessions } from "./remoteSessionStore";
import { buildRecentWorkspaceOptions } from "./newSession";
import { NewTaskSelectionSheet } from "./NewTaskSelectionSheet";
import type { useOrcaWorkerDirectoryPicker } from "./useOrcaWorkerDirectoryPicker";

/** Reuse the new-task workspace presentation, scoped to the Worker's execution device. */
export function OrcaWorkerDirectoryPicker({
  picker,
  deviceId,
  workingDir,
  mode,
  directoryOnly = false,
}: {
  picker: ReturnType<typeof useOrcaWorkerDirectoryPicker>;
  deviceId?: string;
  workingDir?: string;
  mode?: string;
  directoryOnly?: boolean;
}) {
  const sessions = useRemoteSessions();
  const [path, setPath] = useState("");
  const { colors } = useTheme();
  const { t } = useTranslation();
  useEffect(() => {
    setPath(picker.path);
  }, [picker.path, picker.page]);
  const workspaces = buildRecentWorkspaceOptions(
    sessions.filter((session) => session.deviceLinkDeviceId === deviceId),
    deviceId ?? "",
  );
  if (Platform.OS === "web") {
    return (
      <SheetModal
        visible={picker.page !== null}
        onBackdropPress={picker.close}
        onRequestClose={picker.close}
        onClosed={picker.closed}
      >
        <View
          style={{
            backgroundColor: colors.surface,
            padding: spacing.md,
            gap: spacing.sm,
          }}
        >
          <NewTaskSelectionRow
            title={t("settings.projectInfo.cancel")}
            onPress={picker.close}
          />
          <TextInput
            value={path}
            onChangeText={setPath}
            accessibilityLabel={t("settings.projectInfo.directoryPath")}
            placeholder={t("settings.projectInfo.directoryPath")}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              minHeight: 48,
              color: colors.textPrimary,
              fontSize: typeScale.body,
              lineHeight: lineHeight.body,
            }}
            onSubmitEditing={() => {
              if (path.trim()) void picker.load(path.trim());
            }}
          />
          <NewTaskSelectionRow
            title={t("settings.projectInfo.browseDirectory")}
            disabled={picker.loading || !path.trim()}
            onPress={() => void picker.load(path.trim())}
          />
          <ScrollView style={{ maxHeight: 320 }}>
            {picker.loading && <ActivityIndicator />}
            {picker.error && (
              <NewTaskSelectionRow
                title={picker.error}
                onPress={() => void picker.load(picker.path)}
              />
            )}
            {picker.parent && (
              <NewTaskSelectionRow
                title=".."
                onPress={() => void picker.load(picker.parent!)}
              />
            )}
            {picker.drives.map((entry) => (
              <NewTaskSelectionRow
                key={entry.path}
                title={entry.name}
                onPress={() => void picker.load(entry.path)}
              />
            ))}
            {picker.entries.map((entry) => (
              <NewTaskSelectionRow
                key={entry.path}
                title={entry.name}
                onPress={() => void picker.load(entry.path)}
              />
            ))}
          </ScrollView>
          <NewTaskSelectionRow
            title={t("session.new.useCurrent")}
            disabled={picker.loading || !!picker.error || !picker.path}
            onPress={() => {
              if (path.trim() !== picker.path) {
                if (path.trim()) void picker.load(path.trim());
              } else picker.choose(picker.path);
            }}
          />
        </View>
      </SheetModal>
    );
  }
  return (
    <NewTaskSelectionSheet
      directoryInput={
        directoryOnly ? (
          <TextInput
            value={path}
            onChangeText={setPath}
            accessibilityLabel={t("settings.projectInfo.directoryPath")}
            placeholder={t("settings.projectInfo.directoryPath")}
            placeholderTextColor={colors.textPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => {
              if (path.trim()) void picker.load(path.trim());
            }}
            style={{
              color: colors.textPrimary,
              backgroundColor: colors.surfaceChip,
              fontSize: typeScale.body,
              lineHeight: lineHeight.body,
              minHeight: 48,
              paddingHorizontal: spacing.md,
              borderRadius: radius.container,
            }}
          />
        ) : undefined
      }
      page={picker.page}
      busy={false}
      devices={[]}
      selectedDeviceId={deviceId ?? ""}
      workspaces={workspaces}
      workspaceKind={mode === "path" ? "project" : "dialogue"}
      workingDir={workingDir ?? ""}
      path={picker.path}
      parent={picker.parent}
      entries={picker.entries}
      drives={picker.drives}
      loading={picker.loading}
      error={picker.error}
      showHidden={picker.showHidden}
      onClose={picker.close}
      onClosed={picker.closed}
      onBack={directoryOnly ? picker.close : picker.back}
      onDevice={() => undefined}
      onDialogue={() => picker.choose(null)}
      onProject={picker.choose}
      onBrowse={picker.browse}
      onEnter={(path) => void picker.load(path)}
      onChoose={(candidate) => {
        // Resolve an edited address before allowing the previously displayed folder to be selected.
        if (directoryOnly && path.trim() !== picker.path) {
          if (path.trim()) void picker.load(path.trim());
          return;
        }
        picker.choose(candidate);
      }}
      onShowHidden={picker.setShowHidden}
    />
  );
}
