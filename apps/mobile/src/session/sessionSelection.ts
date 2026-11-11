import { i18n } from '@/i18n';
import type { RemoteSession } from '@/session/types';
import {
  summarizeMobileSessionBulkAction as summarizeMobileSessionBulkActionShared,
  type MobileSessionBulkAction,
} from '@cindy/maker-shared/session-selection';

export {
  isMobileSessionBulkActionAvailable,
  mobileSessionBulkActionButtonLabel,
  mobileSessionBulkPatch,
  pruneSessionSelection,
  sessionIdsForListItem,
  toggleSessionSelection,
  visibleMobileSessionBulkActions,
  visibleSessionIdsFromSections,
  type MobileSessionBulkAction,
  type MobileSessionBulkActionLayout,
  type MobileSessionBulkPatch,
  type MobileSessionBulkSummary,
  type MobileSessionWritableStatus,
} from '@cindy/maker-shared/session-selection';

export function summarizeMobileSessionBulkAction<TSession extends RemoteSession>(
  sessions: readonly TSession[],
  action: MobileSessionBulkAction,
) {
  const base = summarizeMobileSessionBulkActionShared(sessions, action);
  const actionLabel = i18n.t(`devices.presentation.bulk.action.${action}`);
  return {
    ...base,
    title: i18n.t('devices.presentation.bulk.title', {
      action: actionLabel,
      count: base.candidates.length,
    }),
    description: i18n.t(base.skippedCount > 0
      ? 'devices.presentation.bulk.descriptionWithSkipped'
      : 'devices.presentation.bulk.description', {
      action: actionLabel,
      count: base.candidates.length,
      skippedCount: base.skippedCount,
    }),
    confirmText: actionLabel,
  };
}
