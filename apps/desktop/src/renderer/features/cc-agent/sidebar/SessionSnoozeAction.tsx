import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { taskSnoozeUntil } from '@cindy/maker-shared/live-task-priority';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import * as sessionService from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';
import { MENU_ITEM_CLASS } from './menuStyles';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  formatTaskSnoozeTime,
  parseTaskSnoozeTime,
  taskSnoozeOptions,
  toLocalDateTimeValue,
} from './taskSnoozeOptions';

/** Inbox action in the existing row action slot; callers apply the row's write permissions. */
export function SessionSnoozeAction({
  session,
  isActive,
  onOpenChange,
}: {
  session: Session;
  isActive: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [menuNow, setMenuNow] = useState(() => new Date());
  const [customValue, setCustomValue] = useState('');
  const [invalidCustom, setInvalidCustom] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  // Keep the existing row action slot visible while either overlay owns focus.
  useEffect(() => onOpenChange(menuOpen || customOpen), [menuOpen, customOpen, onOpenChange]);
  const customDate = parseTaskSnoozeTime(customValue, Date.now());
  const snooze = async (until: string | null) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const updated = await sessionService.patchMeta(session.id, { snoozedUntil: until });
      if (updated.snoozedUntil !== until) throw new Error('UNSUPPORTED_CAPABILITY');
    } catch {
      toast.error(t('ccAgent.sidebar.inbox.snoozeFailed'));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <span
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setMenuNow(new Date());
          setMenuOpen(open);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Tip text={t('ccAgent.sidebar.inbox.snooze')}>
            <button
              ref={triggerRef}
              type="button"
              aria-label={t('ccAgent.sidebar.inbox.snooze')}
              disabled={saving}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              className={cn(
                'shrink-0 size-5 flex items-center justify-center rounded-full focus:outline-none disabled:opacity-40',
                isActive
                  ? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
                  : 'text-sidebar-action-icon hover:bg-sidebar-item-hover hover:text-foreground',
              )}
            >
              <Clock size={14} strokeWidth={2} />
            </button>
          </Tip>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-64 max-w-[calc(100vw-24px)]"
          align="end"
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (customOpen) event.preventDefault();
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {taskSnoozeUntil(session) > Date.now() && (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void snooze(null)}>
              {t('ccAgent.sidebar.inbox.wake')}
            </DropdownMenuItem>
          )}
          {taskSnoozeOptions(menuNow).map((option) => (
            <DropdownMenuItem
              key={option.id}
              className={cn(MENU_ITEM_CLASS, 'justify-between gap-4')}
              onSelect={() => {
                // Save exactly the time shown when the menu opened.
                if (option.until.getTime() <= Date.now()) {
                  setMenuNow(new Date());
                  toast.error(t('ccAgent.sidebar.inbox.invalidTime'));
                  return;
                }
                void snooze(option.until.toISOString());
              }}
            >
              <span>
                {option.hours
                  ? t('ccAgent.sidebar.inbox.hours', { count: option.hours })
                  : t(`ccAgent.sidebar.inbox.${option.id}`)}
              </span>
              <time
                dateTime={option.until.toISOString()}
                className="shrink-0 text-[var(--text-tertiary)] tabular-nums"
              >
                {formatTaskSnoozeTime(option, menuNow, i18n.language)}
              </time>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={() => {
              const initial =
                taskSnoozeUntil(session) > Date.now()
                  ? new Date(taskSnoozeUntil(session))
                  : taskSnoozeOptions(new Date()).find((option) => option.id === 'tomorrow')!.until;
              setCustomValue(toLocalDateTimeValue(initial));
              setInvalidCustom(false);
              setCustomOpen(true);
            }}
          >
            {t('ccAgent.sidebar.inbox.custom')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {customOpen && (
        <ConfirmDialog
          open={customOpen}
          onOpenChange={(open) => {
            setCustomOpen(open);
            if (!open) triggerRef.current?.focus();
          }}
          title={t('ccAgent.sidebar.inbox.snooze')}
          confirmText={t('ccAgent.sidebar.inbox.snooze')}
          confirmDisabled={!customDate || saving}
          onConfirm={() => {
            const selected = parseTaskSnoozeTime(customValue, Date.now());
            if (!selected) {
              setInvalidCustom(true);
              toast.error(t('ccAgent.sidebar.inbox.invalidTime'));
              return;
            }
            void snooze(selected.toISOString());
          }}
          content={
            <div
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <FormField
                label={t('ccAgent.sidebar.inbox.wakeAt')}
                hint={t('ccAgent.sidebar.inbox.timeZone', {
                  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                })}
                error={
                  invalidCustom || !customDate ? t('ccAgent.sidebar.inbox.invalidTime') : undefined
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    value={customValue}
                    min={toLocalDateTimeValue(new Date(Date.now() + 60_000))}
                    max={toLocalDateTimeValue(new Date(Date.now() + 366 * 86_400_000))}
                    onChange={(value) => {
                      setCustomValue(value);
                      setInvalidCustom(false);
                    }}
                  />
                )}
              </FormField>
            </div>
          }
        />
      )}
    </span>
  );
}
