import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import {
  assignBuddyToSet,
  BUDDY_SET_LIMIT,
  buddySetIdForBuddy,
  createBuddySet,
  deleteBuddySet,
  removeBuddyFromSet,
  renameBuddySet,
  setBuddySetCollapsed,
  type BuddyRosterRow,
  type BuddySetsState,
  type BuddySet,
} from '@cindy/maker-shared/buddy-sets';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { remoteBotKey } from './remoteBotRoster';

/**
 * 「伙伴集」:侧栏「伙伴」段里用户命名、可折叠的展示容器。只收伙伴私聊行,
 * 群聊 / 任务 / Cindy 设备行永远留在平铺区(partitionBuddyRoster 的 kind 守卫)。
 * 点容器里的伙伴仍是原来的私聊路由,不产生新 Session、不改伙伴资料。
 * 文案为稳定 i18n key,12 语言与 glossary 词条由 LQA 助手补(见 PR 说明)。
 */

/** Structural view of a sidebar chat row; the real union is wider (pinned/activityAt). */
export interface BuddySetChatEntry {
  kind: 'bot' | 'group' | 'cindy';
  bot?: { id: string; name: string; deviceId?: string };
  group?: { id: string; name: string };
}

export interface BuddySetRosterItem<T> extends BuddyRosterRow {
  entry: T;
  name: string;
}

/** Stable roster key: local buddy id, or host-scoped key for another computer's buddy. */
export function toBuddySetRosterItem<T extends BuddySetChatEntry>(entry: T): BuddySetRosterItem<T> {
  if (entry.kind === 'group') {
    return { entry, id: `group:${entry.group!.id}`, kind: 'group', name: entry.group!.name };
  }
  if (entry.kind === 'cindy') {
    return { entry, id: 'cindy-devices', kind: 'device', name: '' };
  }
  const bot = entry.bot!;
  return {
    entry,
    id: 'deviceId' in bot ? remoteBotKey({ id: bot.id, deviceId: bot.deviceId! }) : bot.id,
    kind: 'buddy',
    name: bot.name,
  };
}

/** Stable keys with English inline defaults: LQA owns the 12 locales + `buddy-set` term. */
export function buddySetCopy(t: TFunction) {
  return {
    new: t('bots.buddySets.new', { defaultValue: 'New buddy set' }),
    rename: t('bots.buddySets.rename', { defaultValue: 'Rename buddy set' }),
    delete: t('bots.buddySets.deleteBuddySet', { defaultValue: 'Delete buddy set' }),
    addBuddy: t('bots.buddySets.addBuddy', { defaultValue: 'Add buddy' }),
    nameLabel: t('bots.buddySets.nameLabel', { defaultValue: 'Name' }),
    namePlaceholder: t('bots.buddySets.namePlaceholder', { defaultValue: 'Name this buddy set' }),
    createTitle: t('bots.buddySets.createTitle', { defaultValue: 'New buddy set' }),
    renameTitle: t('bots.buddySets.renameTitle', { defaultValue: 'Rename buddy set' }),
    createAction: t('bots.buddySets.createAction', { defaultValue: 'Create buddy set' }),
    saveAction: t('bots.buddySets.saveAction', { defaultValue: 'Save name' }),
    cancel: t('bots.buddySets.cancel', { defaultValue: 'Cancel' }),
    collapse: t('bots.buddySets.collapse', { defaultValue: 'Collapse buddy set' }),
    expand: t('bots.buddySets.expand', { defaultValue: 'Expand buddy set' }),
    actions: t('bots.buddySets.actions', { defaultValue: 'Buddy set actions' }),
  };
}

/** Renders only the set containers; flat rows stay in the section's existing list. */
export function BuddySetGroups<T extends BuddySetChatEntry>({
  groups, candidates, buddySets, renderEntry, onChange, onNewSet, onRename,
}: {
  groups: ReadonlyArray<{ set: BuddySet; rows: BuddySetRosterItem<T>[] }>;
  candidates: readonly BuddySetRosterItem<T>[];
  buddySets: BuddySetsState;
  renderEntry: (entry: T) => React.ReactNode;
  onChange: (next: BuddySetsState | ((current: BuddySetsState) => BuddySetsState)) => void;
  onNewSet: () => void;
  onRename: (buddySetId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const copy = buddySetCopy(t);
  const buddies = useMemo(() => candidates.filter((item) => item.kind === 'buddy'), [candidates]);
  if (groups.length === 0) return null;

  return (
    <>
      {groups.map(({ set, rows }) => {
        const collapsed = set.collapsed === true;
        const Chevron = collapsed ? ChevronRight : ChevronDown;
        return (
          <div key={`buddy-set:${set.buddySetId}`} data-buddy-set-id={set.buddySetId}>
            <div className="group/buddy-set flex h-6 items-center gap-1 pr-1 pl-3">
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={collapsed ? copy.expand : copy.collapse}
                onClick={() => onChange((current) => setBuddySetCollapsed(current, set.buddySetId, !collapsed))}
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-11 font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
              >
                <Chevron size={12} strokeWidth={2} />
                <span className="min-w-0 truncate">{set.name}</span>
                <span className="shrink-0 tabular-nums">{set.buddyIds.length}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={copy.actions}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] opacity-0 transition-colors hover:text-[var(--sidebar-nav-text)] focus:opacity-100 group-hover/buddy-set:opacity-100 data-[state=open]:opacity-100"
                  >
                    <Pencil size={12} strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Users size={14} className="mr-2" />
                      {copy.addBuddy}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-72 max-w-64 overflow-y-auto">
                      {buddies.length === 0 ? (
                        <DropdownMenuItem disabled>{copy.addBuddy}</DropdownMenuItem>
                      ) : buddies.map((buddy) => {
                        const ownerId = buddySetIdForBuddy(buddySets, buddy.id);
                        return (
                          <DropdownMenuItem
                            key={buddy.id}
                            onSelect={() => onChange((current) => ownerId === set.buddySetId
                              ? removeBuddyFromSet(current, buddy.id)
                              : assignBuddyToSet(current, buddy.id, set.buddySetId))}
                          >
                            <span className="mr-2 w-3">{ownerId === set.buddySetId ? '✓' : ''}</span>
                            {buddy.name}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onSelect={() => onRename(set.buddySetId, set.name)}>
                    <Pencil size={14} className="mr-2" />
                    {copy.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onNewSet} disabled={buddySets.sets.length >= BUDDY_SET_LIMIT}>
                    <Plus size={14} className="mr-2" />
                    {copy.new}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="danger"
                    onSelect={() => onChange((current) => deleteBuddySet(current, set.buddySetId))}
                  >
                    <Trash2 size={14} className="mr-2" />
                    {copy.delete}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <SectionCollapse collapsed={collapsed}>
              <div className="flex flex-col gap-0.5 pl-2">
                {rows.map((item) => renderEntry(item.entry))}
              </div>
            </SectionCollapse>
          </div>
        );
      })}
    </>
  );
}

/** Name dialog for creating or renaming a buddy set (Radix Dialog + standard controls). */
export function BuddySetNameDialog({ open, initialName, onOpenChange, onSubmit }: {
  open: boolean;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const copy = buddySetCopy(t);
  const [name, setName] = useState(initialName);
  // The caller keeps a stable key for "new", so remounting is not enough to
  // clear the previous draft: reset it whenever a new request opens.
  useEffect(() => { if (open) setName(initialName); }, [open, initialName]);
  if (!open) return null;
  const save = () => {
    const trimmed = name.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(400px,calc(100vw-32px))] flex-col gap-3 p-4 outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
            {initialName ? copy.renameTitle : copy.createTitle}
          </Dialog.Title>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => { event.preventDefault(); save(); }}
          >
            <FormField label={copy.nameLabel} required>
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  onChange={setName}
                  maxLength={80}
                  placeholder={copy.namePlaceholder}
                />
              )}
            </FormField>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {initialName ? copy.saveAction : copy.createAction}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { createBuddySet, renameBuddySet };
