import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Bot, Plus, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BotRosterView } from './BotRosterView';
import { BotGroupCreateDialog } from './BotGroupCreateDialog';
import { useTranslation } from 'react-i18next';

export function BotCreateMenu({ compact = false, label }: { compact?: boolean; label?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'bot' | 'group' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <>
      {label ? (
        <Button
          ref={trigger}
          variant="secondary"
          size="lg"
          onClick={() => setDialog('bot')}
          aria-label={t('bots.add')}
        >
          <Plus size={15} />
          {label}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={trigger}
              type="button"
              className={compact
              ? 'flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover'
              : 'flex h-7 w-7 items-center justify-center rounded-full text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]'
              }
              aria-label={t('bots.list.createMenu')}
            >
              <Plus size={compact ? 16 : 15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => {
            if (dialog) event.preventDefault();
          }}>
            <DropdownMenuItem onSelect={() => setDialog('bot')}>
              <Bot size={14} className="mr-2" />
              {t('bots.list.createTeammate')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('group')}>
              <Users size={14} className="mr-2" />
              {t('bots.groupChat.create.title')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {dialog === 'bot' ? (
        <BotRosterView
          restoreFocus={() => trigger.current?.focus()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'group' ? (
        <BotGroupCreateDialog
          onOpenChange={open => { if (!open) { setDialog(null); trigger.current?.focus(); } }}
          onCreated={id => { setDialog(null); navigate(`/bots/groups/${encodeURIComponent(id)}`); }}
        />
      ) : null}
    </>
  );
}
