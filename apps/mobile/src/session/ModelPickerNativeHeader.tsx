import type { ReactNode } from "react";
export interface ModelPickerNativeHeaderProps {
  query: string;
  onChangeQuery(value: string): void;
  agentContent?: ReactNode;
  noResults?: boolean;
  permissionLabel: string;
  permissionDisabled?: boolean;
  onPermission?(): void;
  testID: string;
}
export function ModelPickerNativeHeader(_props: ModelPickerNativeHeaderProps) {
  return null;
}
