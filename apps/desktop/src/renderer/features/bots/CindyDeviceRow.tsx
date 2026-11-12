import { SIDEBAR_LIST_ROW_ACTIVE_CLASS, SIDEBAR_LIST_ROW_HEIGHT_CLASS } from '@/features/cc-agent/sidebar/listRowStyle';
import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from 'react';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { TeammateRowStatus, TeammateRunningPreview } from './TeammateStatusDot';
import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { CindyDevicePicker } from './CindyDevicePicker';
import type { CindyDeviceOption } from './cindyDeviceRoster';

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
  const showRunning = typing && status !== 'awaiting';
  const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
  return (
    <div
      data-testid="cindy-device-row"
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 transition-colors',
        SIDEBAR_LIST_ROW_HEIGHT_CLASS,
        selected
          ? SIDEBAR_LIST_ROW_ACTIVE_CLASS
          : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`${bot.name} · ${current.label}`}
      />
      <span className="pointer-events-none relative flex shrink-0">
        <BotAvatar bot={bot} size="row" />
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
              'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:hsl(var(--sidebar-item-hover))] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:hsl(var(--sidebar-item-hover))]',
              selected &&
                'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,currentColor_10%,transparent)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,currentColor_16%,transparent)]',
            )}
          />
        </span>
        <span data-teammate-timestamp className={cn('min-h-4 min-w-10 justify-self-end whitespace-nowrap text-right text-11 tabular-nums', mutedClass)}>{timestamp}</span>
        <span
          className={cn('min-w-0 truncate text-12 leading-4', !showRunning && mutedClass)}
          title={typeof subtitle === 'string' ? subtitle : undefined}
        >
          {showRunning ? <TeammateRunningPreview>{subtitle}</TeammateRunningPreview> : subtitle}
        </span>
        <span className="flex min-h-4 items-center justify-end"><TeammateRowStatus status={status} inline /></span>
      </div>
      {children}
    </div>
  );
}
