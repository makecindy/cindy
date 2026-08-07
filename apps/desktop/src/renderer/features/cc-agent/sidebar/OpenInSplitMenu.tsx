import { ChevronRight } from 'lucide-react';
import { useId } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { resolveAgentIslandVisibleSessionIdFromPath } from '@/lib/agentIslandVisibleSessionRoute';
import { toast } from '@/lib/toast';
import {
  MAX_SPLIT_PANES,
  splitGroupStore,
  useSplitGroup,
  type DropSide,
  type SplitGroupAddBlockReason,
} from '../splitGroupStore';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS, MENU_SUB_CONTENT_CLASS } from './menuStyles';

function addBlockedMessage(
  reason: SplitGroupAddBlockReason | null,
  t: ReturnType<typeof useTranslation>['t'],
  isWorker: boolean,
): string {
  if (isWorker) return t('splitGroup.workerUnavailable');
  if (reason === 'limit-reached') {
    return t('splitGroup.limitReached', { count: MAX_SPLIT_PANES });
  }
  if (reason === 'duplicate') return t('splitGroup.alreadyOpen');
  return t('splitGroup.addUnavailable');
}

export function OpenInSplitMenu({
  sessionId,
  orcaRole,
  onOpenSession,
}: {
  sessionId: string;
  orcaRole?: string | null;
  onOpenSession: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const blockedReasonId = useId();
  useSplitGroup();
  const anchorSessionId = resolveAgentIslandVisibleSessionIdFromPath(location.pathname) ?? '';
  const blockReason =
    orcaRole === 'worker'
      ? 'invalid'
      : splitGroupStore.getAddBlockReason(sessionId, anchorSessionId);
  const blockedMessage = blockReason
    ? addBlockedMessage(blockReason, t, orcaRole === 'worker')
    : undefined;

  const open = (side: DropSide) => {
    const currentBlockReason =
      orcaRole === 'worker'
        ? 'invalid'
        : splitGroupStore.getAddBlockReason(sessionId, anchorSessionId);
    if (currentBlockReason || !splitGroupStore.addSession(sessionId, anchorSessionId, side)) {
      toast.warning(addBlockedMessage(currentBlockReason, t, orcaRole === 'worker'));
      return;
    }
    onOpenSession();
  };

  if (blockedMessage) {
    return (
      <DropdownMenuItem
        aria-disabled="true"
        aria-label={t('splitGroup.openInSplit')}
        aria-describedby={blockedReasonId}
        title={blockedMessage}
        onSelect={(event) => {
          event.preventDefault();
          toast.warning(blockedMessage);
        }}
        className={`${MENU_ITEM_CLASS} h-auto min-h-8 cursor-default items-start py-1.5 aria-disabled:opacity-60`}
      >
        <span className="min-w-0">
          <span className="block">{t('splitGroup.openInSplit')}</span>
          <span
            id={blockedReasonId}
            className="block whitespace-normal text-xs text-[var(--cmd-palette-item-meta)]"
          >
            {blockedMessage}
          </span>
        </span>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger aria-label={t('splitGroup.openInSplit')} className={MENU_ROW_CLASS}>
        <span className="flex-1">{t('splitGroup.openInSplit')}</span>
        <ChevronRight size={14} className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={4}
        className={`${MENU_SUB_CONTENT_CLASS} min-w-36 overflow-hidden`}
      >
        {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
          <DropdownMenuItem key={side} onSelect={() => open(side)} className={MENU_ITEM_CLASS}>
            {t(`splitGroup.openSide.${side}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
