import type { ReactNode } from "react";
export interface NativeBottomSheetProps {
  visible: boolean;
  onClose(): void;
  onClosed?: () => void;
  children: ReactNode;
}
export function NativeBottomSheet(_props: NativeBottomSheetProps) {
  return null;
}
