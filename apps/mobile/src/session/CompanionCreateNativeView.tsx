import type { ProfilePanel, ProfileValues } from './companionProfileData';
export interface CompanionCreateNativeViewProps {
  models?: import('react').ReactNode;
  onImport?(): void;
  deviceName: string; nameTaken: boolean; visible: boolean; onClose(): void; onClosed?(): void; panel?: ProfilePanel;
  values: ProfileValues; onChange(values: ProfileValues): void; onSubmit(): void; onRetry(): void;
  online: boolean; busy: boolean; loading: boolean; error: boolean; dirty: boolean;
  /** The typed name already belongs to a teammate on this computer (NFKC, case-insensitive). */
  duplicate?: boolean;
  modelMissing?: boolean;
  /** Why the confirm button is disabled, when the form itself cannot say (host cannot create, name or portrait empty). */
  hint?: string;
  /** The last create is unconfirmed; the retry resends exactly what was sent. */
  locked?: boolean;
}
export function CompanionCreateNativeView(_props: CompanionCreateNativeViewProps) { return null; }
