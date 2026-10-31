import { CompanionSheet } from './CompanionSheet';
import type { ComposerSheetProps } from './ComposerSheet';
import type { MainWindowAction } from '@/components/MobilePrimitives';

type FormAction = MainWindowAction & { onPress(): void };

export type FormSheetProps = Pick<ComposerSheetProps,
  'visible' | 'title' | 'onClose' | 'onClosed' | 'preventDismiss' | 'children' | 'testID'
> & {
  leadingAction: FormAction;
  trailingAction: FormAction;
  onShow?(): void;
};

export function FormSheet(props: FormSheetProps) {
  return <CompanionSheet {...props} initialSnap="full" keyboardAvoidingBehavior="padding" />;
}
