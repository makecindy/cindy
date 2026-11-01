import { teammateSelectionStyle } from './teammateSelection';
import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { TeammateStatusDot } from './TeammateStatusDot';
import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { CindyDevicePicker } from './CindyDevicePicker';
import type { CindyDeviceOption } from './cindyDeviceRoster';
import { formatBotUnreadBadge } from './botListDisplay';

/** One visual row, with separate sibling buttons for opening chat and choosing its device. */
export function CindyDeviceRow({
  current,
  options,
  selected,
  status,
  subtitle,
  timestamp,
  typing,
  onOpen,
  onSelect,
  onContextMenu,
  onKeyDown,
  children,
}: {
  current: CindyDeviceOption;
  options: readonly CindyDeviceOption[];
  selected: boolean;
  status: TeammateStatus;
  subtitle: ReactNode;
  timestamp: string;
  typing?: boolean;
  onOpen: () => void;
  onSelect: (option: CindyDeviceOption) => void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const bot = current.bot;
  const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
  return (
    <div
      data-testid="cindy-device-row"
      style={teammateSelectionStyle}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors',
        selected
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
          : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`${bot.name} · ${current.label}`}
      />
      <span className="pointer-events-none relative flex shrink-0">
        <BotAvatar bot={bot} size="row" />
        <TeammateStatusDot status={status} />
      </span>
      <div className="pointer-events-none relative grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {'pinnedAt' in bot && bot.pinnedAt ? (
            <Pin size={11} aria-label={t('bots.list.pinned')} className="shrink-0" />
          ) : null}
          <span
            className={cn(
              'min-w-0 truncate text-14 leading-5',
              current.unread && 'font-medium',
            )}
          >
            {bot.name}
          </span>
          <CindyDevicePicker
            options={options}
            current={current}
            onSelect={onSelect}
            className={cn(
              'pointer-events-auto min-w-0 shrink px-1 text-11 text-inherit focus-visible:ring-inset',
              '[--button-face-bg:transparent] [--button-face-border:transparent] [--button-face-outset:0px]',
              'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--sidebar-item-hover)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--sidebar-item-hover)]',
              selected &&
                'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,currentColor_10%,transparent)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,currentColor_16%,transparent)]',
            )}
          />
        </span>
        <span className={cn('min-h-4 min-w-10 justify-self-end whitespace-nowrap text-right text-11 tabular-nums', mutedClass)}>{timestamp}</span>
        <span
          className={cn('truncate text-12 leading-4', mutedClass, typing && 'italic')}
          title={typeof subtitle === 'string' ? subtitle : undefined}
        >
          {subtitle}
        </span>
        <span className="flex min-h-4 items-center justify-end">
          {current.unread && current.unreadCount ? (
            <span
              aria-label={t('bots.list.unread', { count: current.unreadCount })}
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1 text-10 text-[var(--bot-unread-fg)]"
            >
              {formatBotUnreadBadge(current.unreadCount)}
            </span>
          ) : null}
        </span>
      </div>
      {children}
    </div>
  );
}
