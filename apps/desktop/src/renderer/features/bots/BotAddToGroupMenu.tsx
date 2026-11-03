/** Create a group with the current teammate or add it to an existing group. */
import { useRef, useState } from 'react';
import { MessagesSquare, UserPlus, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { BotGroupCreateDialog, isSelectable } from './BotGroupCreateDialog';
import { refreshBotGroups, useBotGroupList } from './botGroupStore';
import { useBotProfiles } from './botStore';
import { chatErrorKey } from './chatError';

const key = (name: string) => `bots.groupChat.addFromChat.${name}`;
const groupRoute = (id: string) => `/bots/groups/${encodeURIComponent(id)}`;

export function BotAddToGroupMenu({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bot = useBotProfiles().find(profile => profile.id === botId);
  const { groups } = useBotGroupList();
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A paused, disabled or archived teammate cannot join anything: no entry rather than a dead one.
  if (!bot || !isSelectable(bot)) return null;
  const joinable = groups.filter(group => group.serverBacked && !group.archived
    && !group.members.some(member => member.botId === botId));

  async function addTo(groupId: string, groupName: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const owner = getDataOwnerGeneration();
    const failed = (code: string) => { if (isDataOwnerGenerationCurrent(owner)) toast.error(t(chatErrorKey(code))); };
    try {
      const api = window.electronAPI.maker.chatServer;
      const owned = await api.ownedBots();
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!owned.ok) { failed(owned.errorCode); return; }
      const actorId = owned.bots.find(candidate => candidate.botId === botId)?.actorId;
      if (!actorId) { toast.error(t(key('unavailable'), { name: bot!.name })); return; }
      const result = await api.manage({ groupId, action: { type: 'member', actorId, action: 'invite' } });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) { failed(result.errorCode); return; }
      refreshBotGroups();
      toast.success(t(key('added'), { name: bot!.name, group: groupName }), {
        // Long enough to reach the action; hover and focus pause it further.
        duration: 6000,
        // The toast outlives this account: after a switch its group belongs to someone else.
        action: { label: t(key('openGroup')), onClick: () => { if (isDataOwnerGenerationCurrent(owner)) navigate(groupRoute(groupId)); } },
      });
    } catch {
      failed('REQUEST_FAILED');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const label = t(key('triggerFor'), { name: bot.name });
  return (
    <>
      {/* busyRef flips before focus returns to the trigger, so a repeated Enter cannot reopen
          the menu while the previous addition is still pending. */}
      <DropdownMenu open={menuOpen} onOpenChange={open => {
        if (open && busyRef.current) return;
        if (open) refreshBotGroups();
        setMenuOpen(open);
      }}>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={label}
            title={label}
            disabled={busy}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
            style={WINDOW_NO_DRAG_STYLE}
          >
            <UserPlus size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (creating) event.preventDefault(); }}>
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Users size={14} className="mr-2" />
            {t(key('newGroup'))}
          </DropdownMenuItem>
          {joinable.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <MessagesSquare size={14} className="mr-2" />
                {t(key('existingGroup'))}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 max-w-64 overflow-y-auto">
                {/* Name both sides of the action before it runs: this teammate, into that group. */}
                <DropdownMenuLabel className="truncate">{t(key('addTo'), { name: bot.name })}</DropdownMenuLabel>
                {joinable.map(group => (
                  <DropdownMenuItem key={group.id} disabled={busy} onSelect={() => void addTo(group.id, group.name)}>
                    <span className="min-w-0 truncate">{group.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {creating ? (
        <BotGroupCreateDialog
          privateChatBotId={botId}
          onOpenChange={open => { if (!open) { setCreating(false); trigger.current?.focus(); } }}
          onCreated={id => { setCreating(false); navigate(groupRoute(id), { state: { createdGroupInvite: id } }); }}
        />
      ) : null}
    </>
  );
}
