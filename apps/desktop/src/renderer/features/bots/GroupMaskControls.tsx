import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { BotAvatar } from './BotAvatar';
import { BOT_GROUP_SETTINGS_PARAM } from './botGroupPresentation';
import { GROUP_MASK_SETTINGS_PARAM, useGroupMask, type GroupMaskIdentity, type GroupMaskPresentation } from './groupMaskPresentation';

const key = (name: string) => `bots.groupChat.mask.${name}`;

export function GroupMaskAvatar({ self, companion, compact = false }: {
  self: GroupMaskIdentity; companion?: GroupMaskIdentity; compact?: boolean;
}) {
  return <span aria-hidden className={compact ? 'relative inline-flex h-6 w-[29px] shrink-0' : 'relative inline-flex h-7 w-7 shrink-0'}>
    <BotAvatar bot={self} size={compact ? 'xs' : 'sm'} />
    {companion && <span className={compact
      ? 'absolute left-3 top-[7px] flex h-[17px] w-[17px] rounded-full border-2 border-[var(--surface)]'
      : 'absolute -bottom-1 -right-1 flex rounded-full border-2 border-[var(--surface)]'}>
      <BotAvatar bot={companion} size="xs" className={compact ? 'h-full w-full text-10' : undefined} />
    </span>}
  </span>;
}

export function GroupMaskStatusText({ mask }: { mask: GroupMaskPresentation }) {
  const { t } = useTranslation();
  return <span>{mask.status === 'paused' && mask.settings.trigger === 'always'
    ? t(key('presence'), { minutes: mask.settings.resumeMinutes })
    : mask.status === 'waiting' && mask.settings.trigger === 'scheduled'
      ? t(key('scheduledWait'), { time: mask.settings.start })
      : t(key(`detail.${mask.status}`))}</span>;
}

export function useOpenGroupMask() {
  const [, setParams] = useSearchParams();
  return () => setParams(current => {
    const next = new URLSearchParams(current);
    next.set(BOT_GROUP_SETTINGS_PARAM, '1'); next.set(GROUP_MASK_SETTINGS_PARAM, '1'); return next;
  });
}

export function GroupMaskIndicator({ groupId, onTakeOver }: { groupId: string; onTakeOver: () => void }) {
  const mask = useGroupMask(groupId);
  return mask ? <MaskIndicator mask={mask} onTakeOver={onTakeOver} /> : null;
}

function MaskIndicator({ mask, onTakeOver }: { mask: GroupMaskPresentation; onTakeOver: () => void }) {
  const openSettings = useOpenGroupMask();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [focusInput, setFocusInput] = useState(false);
  const companion = mask.companions.find(c => c.id === mask.settings.companionId);
  const label = t(key(`status.${mask.status}`));
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" data-testid="group-mask-status" data-status={mask.status} title={`${t(key('title'))} · ${label}`}
        aria-label={`${t(key('title'))} · ${label}`}
        className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-12 text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        <GroupMaskAvatar self={mask.self} companion={companion} compact />
        <span className="whitespace-nowrap" aria-live="polite">{label}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" sideOffset={8} className="max-w-[calc(100vw-32px)] space-y-3"
      onCloseAutoFocus={event => { if (focusInput) { event.preventDefault(); onTakeOver(); setFocusInput(false); } }}>
      <h3 className="text-14 font-medium">{t(key('title'))}</h3>
      <p className="text-13 leading-normal text-[var(--text-secondary)]"><GroupMaskStatusText mask={mask} /></p>
      {mask.status === 'enabled' ? <Button size="sm" variant="secondary" className="w-full"
        onClick={() => { mask.participate(); setFocusInput(true); setOpen(false); }}>{t(key('takeover'))}</Button>
        : mask.status === 'paused' || mask.status === 'waiting' && mask.settings.trigger === 'manual'
          ? <Button size="sm" variant="secondary" className="w-full" onClick={() => { mask.resume(); setOpen(false); }}>{t(key('resume'))}</Button> : null}
      <button type="button" className="flex min-h-8 w-full items-center justify-between text-13 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        onClick={() => { setOpen(false); openSettings(); }}>{t(key('settings'))}<ChevronRight size={14} /></button>
    </PopoverContent>
  </Popover>;
}

export function GroupMaskMessageAvatar({ messageId, attribution: supplied }: { messageId: string; attribution?: { self: GroupMaskIdentity; companion: GroupMaskIdentity } }) {
  const mask = useGroupMask();
  const { t } = useTranslation();
  const attribution = supplied ?? mask?.attributions[messageId];
  if (!attribution) return null;
  const label = t(key('attribution'), { name: attribution.companion.name, owner: attribution.self.name });
  return <Tip text={label}><button type="button" aria-label={label}
    className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
    <GroupMaskAvatar {...attribution} />
  </button></Tip>;
}
