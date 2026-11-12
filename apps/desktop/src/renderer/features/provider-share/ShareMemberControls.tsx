/**
 * 「用量」块里分享的人那一行的分享部分(2026-10-16 用户要求：「已分享的人」并进「用量」，同一个人只占一行)：
 * 分享状态、关闭／恢复与删除(收进行内 `···`，与组内电脑一行的「移出组」同一模式)，以及经这个人的供应商组
 * 转给别人用、已处理过的人(provider-sharing.md §4.3)。操作由「远程与分享」页执行，结果以 toast 说明。
 */
import { CirclePause, CirclePlay, MoreHorizontal, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { ProviderShareMemberView, ProviderShareReshareView } from '../../../shared/providerShare';
import { providerShareMemberName } from '../../../shared/providerShareMemberNote';
import { ShareAvatar } from './ShareAvatar';

export interface ProviderShareMemberActions {
  /** 这个成员(或转分享记录)的操作正在进行，或分享没读出来：不能再点。 */
  busy: (id: string) => boolean;
  /** 供应商目录确认之前不能同意转分享。 */
  canApproveReshare: boolean;
  onTogglePause: (member: ProviderShareMemberView) => void;
  onRemove: (member: ProviderShareMemberView) => void;
  onEditNote: (member: ProviderShareMemberView, trigger: HTMLButtonElement | null) => void;
  onModelAccess?: (member: ProviderShareMemberView, trigger: HTMLButtonElement | null) => void;
  onReshare: (member: ProviderShareMemberView, reshare: ProviderShareReshareView, decision: 'approve' | 'reject') => void;
}

/** 名字旁的分享状态：正常(有任务在跑时带上几个)、已暂停。 */
export function ShareMemberStatus({ member }: { member: ProviderShareMemberView }) {
  const { t } = useTranslation();
  const paused = member.status === 'paused';
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          paused ? 'bg-[var(--remote-status-disconnected)]' : 'bg-[var(--remote-status-ready)]',
        )}
      />
      {paused
        ? t('providerShare.manage.members.statusPaused')
        : member.runningTasks > 0
          ? t('providerShare.manage.members.statusRunning', { count: member.runningTasks })
          : t('providerShare.manage.members.statusActive')}
    </span>
  );
}

/** 行尾 `···`：关闭／恢复分享、删除(删除前由页面二次确认)。 */
export function ShareMemberMenu({
  member,
  disabled,
  onTogglePause,
  onRemove,
  onEditNote,
  onModelAccess,
}: {
  member: ProviderShareMemberView;
  disabled: boolean;
  onTogglePause: () => void;
  onRemove: () => void;
  onEditNote: (trigger: HTMLButtonElement | null) => void;
  onModelAccess?: (trigger: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const paused = member.status === 'paused';
  const label = t('providerShare.manage.members.moreAria', { name: providerShareMemberName(member) });
  const PauseIcon = paused ? CirclePlay : CirclePause;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip text={label}>
          <button
            ref={triggerRef}
            type="button"
            aria-label={label}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <MoreHorizontal size={18} />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onModelAccess && <DropdownMenuItem disabled={disabled} onClick={() => onModelAccess(triggerRef.current)}>
          <SlidersHorizontal size={18} className="mr-2.5" />
          {t('providerShare.modelAccess.memberTitle')}
        </DropdownMenuItem>}
        <DropdownMenuItem disabled={disabled} onClick={() => onEditNote(triggerRef.current)}>
          <Pencil size={18} className="mr-2.5" />
          {t(member.note ? 'providerShare.manage.memberNote.edit' : 'providerShare.manage.memberNote.add')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onClick={onTogglePause}>
          <PauseIcon size={18} className="mr-2.5" />
          {t(paused ? 'providerShare.manage.members.resume' : 'providerShare.manage.members.pause')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="danger" disabled={disabled} onClick={onRemove}>
          <Trash2 size={18} className="mr-2.5" />
          {t('providerShare.manage.members.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 经这个人的供应商组转给别人用、已处理过的人(待处理的在页面标题下的「待处理」里)：已同意的可以撤回，
 * 拒绝的可以改为同意。缩进到昵称一列，看得出属于上面这个人。
 */
export function ShareMemberReshares({
  member,
  actions,
  className,
}: {
  member: ProviderShareMemberView;
  actions: ProviderShareMemberActions;
  className?: string;
}) {
  const { t } = useTranslation();
  const decided = (member.reshares ?? []).filter((reshare) => reshare.state !== 'pending');
  if (decided.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="provider-share-reshare-list">
      <span className="text-12 text-[var(--text-tertiary)]">
        {t('providerShare.manage.reshare.listTitle', { owner: providerShareMemberName(member) })}
      </span>
      {decided.map((reshare) => {
        const approved = reshare.state === 'approved';
        return (
          <div key={reshare.id} data-testid="provider-share-reshare-item" className="flex flex-wrap items-center gap-2">
            <ShareAvatar
              displayName={reshare.name}
              avatarUrl={reshare.avatarUrl}
              size="sm"
              className={cn(!approved && 'opacity-70')}
            />
            <span className={cn('min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]', !approved && 'opacity-70')}>
              {reshare.name}
              <span className="ml-2 text-12 text-[var(--text-secondary)]">
                {t(approved ? 'providerShare.manage.reshare.stateApproved' : 'providerShare.manage.reshare.stateRejected')}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              compact
              tone={approved ? 'danger' : undefined}
              disabled={actions.busy(reshare.id) || (!approved && !actions.canApproveReshare)}
              aria-label={t(
                approved ? 'providerShare.manage.reshare.revokeAria' : 'providerShare.manage.reshare.approveAria',
                { name: reshare.name },
              )}
              onClick={() => actions.onReshare(member, reshare, approved ? 'reject' : 'approve')}
            >
              {t(approved ? 'providerShare.manage.reshare.revoke' : 'providerShare.manage.reshare.approve')}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
