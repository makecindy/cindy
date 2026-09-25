import type { ReactNode } from 'react';
import type { RemoteResource } from '@cindy/device-link';
import type { CompanionProfileData, ProfilePanel, ProfileValues } from './companionProfileData';
export interface CompanionProfileNativeViewProps {
  visible: boolean; title: string; name: string; page: string; deviceId: string; deviceName: string;
  resource: RemoteResource | null; data: CompanionProfileData | null; editor: CompanionProfileData | null;
  panel?: ProfilePanel; values: ProfileValues; busy: boolean; online: boolean; dirty: boolean;
  loading: boolean; error: boolean; errorLabel?: string; conflict: boolean; receipt: string | null;
  confirmation: ProfilePanel | null; deleted: boolean; artifacts: ReactNode; models: ReactNode;
  /** Saved-memories page (list / detail / edit), and whether the host offers it. */
  memoryPage: ReactNode; hasMemoryEntries: boolean;
  onClose(): void; onClosed?(): void; onBack?(): void; onOpen(page: string): void;
  onChange(values: ProfileValues): void; onSubmit(panel: ProfilePanel, confirmed?: boolean): void;
  onConfirm(panel: ProfilePanel | null): void; onRetry(): void; onDiscard(reload: boolean): void;
  onEditor(resourceId: string): void; onEditorPanel(panel: ProfilePanel): void;
  onSearch(): void; onAutomation(): void;
}
// SwiftUI is isolated from Android's bundle. The shared component owns all draft/save logic.
export function CompanionProfileNativeView(_props: CompanionProfileNativeViewProps) { return null; }
