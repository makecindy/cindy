import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Bot, Link2, Plus, Store, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BotRosterView } from './BotRosterView';
import { BotGroupCreateDialog } from './BotGroupCreateDialog';
import { BotMarketDialog } from './BotMarketDialog';
import { ChatInviteDialog } from './ChatInviteDialog';
import { useTranslation } from 'react-i18next';

/** `header`:侧栏伙伴段头里的 20px 图标钮,与置顶 / 全部任务段头动作同尺寸。 */
export function BotCreateMenu({ variant, label }: {
  variant?: 'header';
  label?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'bot' | 'group' | 'market' | 'join' | null>(null);
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
              className={variant === 'header'
              ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]'
              : 'flex h-7 w-7 items-center justify-center rounded-full text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]'
              }
              aria-label={t('bots.list.createMenu')}
            >
              <Plus size={variant === 'header' ? 13 : 15} strokeWidth={variant === 'header' ? 2 : undefined} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => {
            if (dialog) event.preventDefault();
          }}>
            <DropdownMenuItem onSelect={() => setDialog('market')}>
              <Store size={14} className="mr-2" />
              {t('bots.market.heading')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('bot')}>
              <Bot size={14} className="mr-2" />
              {t('bots.list.createTeammate')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog('group')}>
              <Users size={14} className="mr-2" />
              {t('bots.groupChat.create.title')}
            </DropdownMenuItem>
            {/* Clicking an invitation opens it directly; this is the fallback when the link
                arrived as plain text that the sending app did not make clickable. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDialog('join')}>
              <Link2 size={14} className="mr-2" />
              {t('bots.list.joinWithLink')}
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
      {dialog === 'market' ? <BotMarketDialog onClose={() => { setDialog(null); trigger.current?.focus(); }} /> : null}
      {dialog === 'group' ? (
        <BotGroupCreateDialog
          onOpenChange={open => { if (!open) { setDialog(null); trigger.current?.focus(); } }}
          onCreated={id => { setDialog(null); navigate(`/bots/groups/${encodeURIComponent(id)}`); }}
        />
      ) : null}
      {dialog === 'join' ? (
        <ChatInviteDialog
          onClose={() => { setDialog(null); trigger.current?.focus(); }}
          onJoined={id => navigate(`/bots/groups/${encodeURIComponent(id)}`)}
        />
      ) : null}
    </>
  );
}
