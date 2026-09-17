import type { MobilePermissionPickerListProps } from "./MobilePermissionPickerList";
export interface NativePermissionSheetProps extends MobilePermissionPickerListProps {
  visible: boolean;
  onClose(): void;
}
export function NativePermissionSheet(_props: NativePermissionSheetProps) {
  return null;
}
