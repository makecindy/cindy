import type { Dispatch, SetStateAction } from 'react';
import type { RemoteResource } from '@cindy/device-link';
import type { RoutineDefinition, RoutineDetail, RoutineSummary } from './companionRoutines';

export interface CompanionAutomationNativeViewProps {
  visible: boolean; online: boolean; busy: boolean; loading: boolean; dirty: boolean;
  error: string | null; selected: string | null; draftGeneration: number;
  resource: RemoteResource | null; items: RoutineSummary[]; detail: RoutineDetail | null;
  draft: RoutineDefinition | null;
  onChange: Dispatch<SetStateAction<RoutineDefinition | null>>;
  onClose(): void; onBack(): void; onOpen(id: string): void; onRetry(): void;
  onAct(action: string): void; onDelete(): void;
}

// Keep SwiftUI out of non-iOS bundles. Drafts and remote actions stay in the shared sheet.
export function CompanionAutomationNativeView(_props: CompanionAutomationNativeViewProps) { return null; }
