import { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { SheetSurface } from "@/session/SheetSurface";
import { NewTaskSelectionRow } from "@/session/NewTaskSelectionRow";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "@/session/contextSheetModel";

/**
 * Android computer picker for the installed plugin list. iOS uses the native menu in
 * `PluginDirectoryView.ios.tsx`. A system alert shows at most three buttons, so with two or more
 * computers it dropped choices and Cancel (Back could not close it) and upper-cased the names;
 * this reuses the new-task computer sheet and rows, so every choice, Back and the backdrop work.
 */
export function PluginComputerPicker({
  visible,
  targets,
  deviceId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  targets: readonly { deviceId: string; deviceName: string }[];
  /** Current filter; empty means all computers. */
  deviceId: string;
  onSelect(deviceId: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  useEffect(() => {
    if (visible) setSnap("half");
  }, [visible]);
  const insets = useSafeAreaInsets(),
    { height } = useWindowDimensions();
  const heights = useMemo(
    () =>
      computeContextSheetSnapHeights({
        screenHeight: height,
        safeAreaTopInset: insets.top,
      }),
    [height, insets.top],
  );
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={onClose}
      onBackdropPress={onClose}
    >
      <SheetSurface
        title={t("plugins.computer")}
        onClose={onClose}
        heights={heights}
        snap={snap}
        onSnapChange={setSnap}
        bottomInset={insets.bottom}
        testID="plugins.computerPicker"
      >
        <NewTaskSelectionRow
          testID="plugins.computer.all"
          title={t("plugins.allComputers")}
          selected={!deviceId}
          onPress={() => onSelect("")}
        />
        {targets.map((host) => (
          <NewTaskSelectionRow
            key={host.deviceId}
            testID={`plugins.computer.${host.deviceId}`}
            title={host.deviceName}
            selected={host.deviceId === deviceId}
            onPress={() => onSelect(host.deviceId)}
          />
        ))}
      </SheetSurface>
    </SheetModal>
  );
}
