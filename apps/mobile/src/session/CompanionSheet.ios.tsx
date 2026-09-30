import { ComposerSheet } from './ComposerSheet';
import type { CompanionSheetProps } from './CompanionSheet';
/** Use the shared native detents, safe-area and dismissal lifecycle. */
export function CompanionSheet(props: CompanionSheetProps) {
  return <ComposerSheet {...props} />;
}
