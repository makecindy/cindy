import type { ProfilePanel, ProfileValues } from './companionProfileData';
export interface CompanionCreateNativeViewProps {
  deviceName: string; nameTaken: boolean; visible: boolean; onClose(): void; onClosed?(): void; panel?: ProfilePanel;
  values: ProfileValues; onChange(values: ProfileValues): void; onSubmit(): void; onRetry(): void;
  online: boolean; busy: boolean; loading: boolean; error: boolean; dirty: boolean;
}
export function CompanionCreateNativeView(_props: CompanionCreateNativeViewProps) { return null; }
