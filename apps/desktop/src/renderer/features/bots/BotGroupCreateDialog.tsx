/**
 * 新建群聊：填群名称，选 2–6 位本机伙伴。
 *
 * 表单弹窗遵循 DESIGN.md §4 Dialog & Modal：无右上角 ×，点遮罩不关闭（误触不能丢掉
 * 填了一半的表单），Esc 与底部「取消」关闭，打开时聚焦群名称。成员数与群名长度由
 * main 最终校验，这里先挡住明显不成立的提交并把焦点送到第一个出错的字段。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import { BOT_GROUP_NAME_MAX_CHARS } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { botGroupApi, refreshBotGroups } from './botGroupStore';
import { BOT_GROUP_MAX_MEMBERS, BOT_GROUP_MIN_MEMBERS, botGroupErrorKey } from './botGroupPresentation';
import { useBotProfiles, type BotProfile } from './botStore';

/** Local Bots that may appear in the picker; archived and deleting ones never do. */
function pickableBots(bots: readonly BotProfile[]): BotProfile[] {
  return bots
    .filter((bot) => bot.status !== 'archived' && bot.status !== 'deleting')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function isSelectable(bot: BotProfile): boolean {
  return (bot.status ?? 'active') === 'active' && bot.enabled !== false;
}

export function BotGroupCreateDialog({
  onOpenChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  onCreated: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  const candidates = useMemo(() => pickableBots(bots), [bots]);
  const selectableCount = candidates.filter(isSelectable).length;
  const [serverBacked, setServerBacked] = useState(false);
  useEffect(() => {
    let disposed = false;
    void botGroupApi()?.chatServer?.status().then(s => { if (!disposed) setServerBacked(s.enabled); }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);
  const minMembers = serverBacked ? 0 : BOT_GROUP_MIN_MEMBERS;
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const firstMemberRef = useRef<HTMLButtonElement>(null);

  // Speaking order follows the picker's order, not the click order.
  const orderedSelection = candidates
    .filter((bot) => selectedIds.includes(bot.id))
    .map((bot) => bot.id);
  const atLimit = orderedSelection.length >= BOT_GROUP_MAX_MEMBERS;

  const toggle = (botId: string) => {
    setSubmitError(null);
    setSelectedIds((current) => {
      if (current.includes(botId)) return current.filter((id) => id !== botId);
      if (current.length >= BOT_GROUP_MAX_MEMBERS) return current;
      return [...current, botId];
    });
    setMembersError(false);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busyRef.current) return;
    const trimmed = name.trim();
    const nameInvalid = trimmed.length === 0;
    const membersInvalid =
      orderedSelection.length < minMembers ||
      orderedSelection.length > BOT_GROUP_MAX_MEMBERS;
    setNameError(nameInvalid);
    setMembersError(membersInvalid);
    if (nameInvalid) {
      nameInputRef.current?.focus();
      return;
    }
    if (membersInvalid) {
      firstMemberRef.current?.focus();
      return;
    }
    const api = botGroupApi();
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    const owner = getDataOwnerGeneration();
    try {
      if (!api) throw new Error('Bot group IPC is unavailable');
      const result = await api.createBotGroup({ name: trimmed, botIds: orderedSelection });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) {
        setSubmitError(t(botGroupErrorKey(result.errorCode, 'bots.groupChat.create.failed')));
        return;
      }
      refreshBotGroups();
      onCreated(result.groupId);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setSubmitError(t('bots.groupChat.create.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const membersHint =
    selectableCount < minMembers
      ? t('bots.groupChat.create.notEnoughBots', { min: BOT_GROUP_MIN_MEMBERS })
      : undefined;

  return (
    <Dialog.Root open onOpenChange={(open) => !busyRef.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // CJK IME: Escape during composition only cancels the candidate.
            if (event.isComposing || event.keyCode === 229 || busyRef.current) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInputRef.current?.focus();
          }}
          className="fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(460px,calc(100vw-32px))] flex-col rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-4 outline-none"
        >
          <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)} noValidate>
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
              {t('bots.groupChat.create.title')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-13 leading-normal text-[var(--confirm-desc)]">
              {t(serverBacked ? 'bots.groupChat.server.createDescription' : 'bots.groupChat.create.description')}
            </Dialog.Description>

            <div className="mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto">
              <FormField
                label={t('bots.groupChat.nameLabel')}
                error={nameError ? t('bots.groupChat.create.nameRequired') : undefined}
                required
              >
                {(control) => (
                  <Input
                    {...control}
                    inputRef={nameInputRef}
                    size="md"
                    value={name}
                    maxLength={BOT_GROUP_NAME_MAX_CHARS}
                    placeholder={t('bots.groupChat.create.namePlaceholder')}
                    onChange={(value) => {
                      setName(value);
                      if (value.trim()) setNameError(false);
                      setSubmitError(null);
                    }}
                    onKeyDown={(event) => {
                      // Confirming an IME candidate must not submit the form.
                      if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                        event.preventDefault();
                      }
                    }}
                  />
                )}
              </FormField>

              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    id="bot-group-create-members-label"
                    className="text-13 font-medium text-[var(--settings-section-title)]"
                  >
                    {t('bots.groupChat.create.membersLabel')}
                  </span>
                  <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                    {t('bots.groupChat.create.selectedCount', {
                      count: orderedSelection.length,
                      max: BOT_GROUP_MAX_MEMBERS,
                    })}
                  </span>
                </div>
                {candidates.length > 0 ? (
                  <div
                    role="group"
                    aria-labelledby="bot-group-create-members-label"
                    aria-describedby="bot-group-create-members-feedback"
                    className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--border-default)] p-1"
                  >
                    {candidates.map((bot, index) => {
                      const checked = selectedIds.includes(bot.id);
                      const selectable = isSelectable(bot);
                      const disabled = busy || !selectable || (!checked && atLimit);
                      return (
                        <button
                          key={bot.id}
                          ref={index === 0 ? firstMemberRef : undefined}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          disabled={disabled}
                          onClick={() => toggle(bot.id)}
                          className={cn(
                            'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-13 text-[var(--text-primary)] outline-none transition-colors',
                            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                            'enabled:hover:bg-[var(--model-item-hover)] disabled:cursor-not-allowed',
                            !selectable && 'opacity-60',
                          )}
                        >
                          <BotAvatar bot={bot} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                          {!selectable ? (
                            <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                              {t(
                                bot.status === 'paused'
                                  ? 'bots.groupChat.memberStatus.paused'
                                  : 'bots.groupChat.memberStatus.unavailable',
                              )}
                            </span>
                          ) : null}
                          <span
                            aria-hidden
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                              checked
                                ? 'border-transparent bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
                                : 'border-[var(--text-tertiary)]',
                            )}
                          >
                            {checked ? <Check size={12} strokeWidth={3} /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div id="bot-group-create-members-feedback" className="text-12 leading-snug">
                  {membersHint ? <p className="text-[var(--form-field-hint)]">{membersHint}</p> : null}
                  <p aria-live="polite" className="text-[var(--error-fg)]">
                    {membersError
                      ? t('bots.groupChat.create.minMembers', { min: BOT_GROUP_MIN_MEMBERS })
                      : null}
                  </p>
                </div>
              </div>
            </div>

            {submitError ? (
              <p role="alert" className="mt-2 text-12 text-[var(--error-fg)]">
                {submitError}
              </p>
            ) : null}

            <div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2.5">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary" palette="confirmation" size="lg" disabled={busy}>
                  {t('bots.cancel')}
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="cta" palette="confirmation" size="lg" loading={busy}>
                {t('bots.groupChat.create.submit')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
