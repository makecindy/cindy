import { useTranslation } from 'react-i18next';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { Session } from '@/lib/ccAgent.types';
import type { FilterStatus } from '../hooks/useSidebarFilter';
import { projectBulkArchiveActionForStatus } from '../lib/projectBulkArchiveAction';
import { MENU_ITEM_CLASS } from './menuStyles';

/** The dialogue category has group actions, but no project identity or shared directory. */
export function DialogueGroupMenu({
  sessions,
  statusFilter,
  onSearch,
  onArchiveAll,
}: {
  sessions: readonly Session[];
  statusFilter: FilterStatus;
  onSearch: () => void;
  onArchiveAll: () => void;
}) {
  const { t } = useTranslation();
  const hasRemoteTasks = sessions.some((session) => Boolean(session.deviceLinkDeviceId));
  return (
    <>
      <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={onSearch}>
        {t('ccAgent.sidebar.dialogueAction.search')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className={MENU_ITEM_CLASS}
        disabled={hasRemoteTasks}
        onSelect={onArchiveAll}
      >
        <span>
          {t(
            projectBulkArchiveActionForStatus(statusFilter) === 'unarchive'
              ? 'ccAgent.sidebar.dialogueAction.restoreAll'
              : 'ccAgent.sidebar.projectAction.archivedAll',
          )}
        </span>
      </DropdownMenuItem>
      {hasRemoteTasks && (
        <DropdownMenuLabel className="max-w-60 whitespace-normal text-xs font-normal">
          {t('ccAgent.sidebar.dialogueAction.remoteBulkUnavailable')}
        </DropdownMenuLabel>
      )}
    </>
  );
}
