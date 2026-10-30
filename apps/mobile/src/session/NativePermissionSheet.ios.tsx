import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ComposerSheet } from "./ComposerSheet";
import { MobilePermissionPickerList } from "./MobilePermissionPickerList";
import type { NativePermissionSheetProps } from "./NativePermissionSheet";
export function NativePermissionSheet(props: NativePermissionSheetProps) {
  const { t } = useTranslation();
  const pending = useRef<(() => void) | null>(null);
  return (
    <ComposerSheet
      nativeContent
      visible={props.visible}
      onClose={props.onClose}
      onClosed={() => {
        const action = pending.current;
        pending.current = null;
        action?.();
      }}
      title={t("models.picker.permissionTitle")}
      testID={props.testID}
    >
      <MobilePermissionPickerList
        {...props}
        onSelect={(mode) => {
          pending.current = () => props.onSelect(mode);
          props.onClose();
        }}
      />
    </ComposerSheet>
  );
}
