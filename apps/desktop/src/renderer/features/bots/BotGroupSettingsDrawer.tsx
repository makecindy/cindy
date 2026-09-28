/**
 * 群设置抽屉：群名称、成员（移出 / 添加伙伴 / 设为负责人）、项目文件夹、没有 @ 人时的
 * 回复方式、发言方式、删除群聊。
 *
 * 与 BotSettingsDrawer 同一个外壳：由路由上的 `?groupSettings=1` 打开，群聊页留在下面；
 * 点遮罩不关闭，Esc（IME 组合中除外）与右上角关闭按钮关闭。每项改动立即提交给 main，
 * 群数据以 botGroupStore 的列表摘要为准（main 推送后自动刷新），失败就地提示并保持
 * 原值。成员数 2–6 由 main 最终校验，这里只把不会成立的操作提前禁用。
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Folder, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import {
  BOT_GROUP_NAME_MAX_CHARS,
  type BotGroupMutationResult,
  type BotGroupReplyMode,
  type BotGroupSpeakingMode,
  type BotGroupSummary,
} from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { BotGroupAvatarStack } from './BotGroupAvatars';
import { BotGroupOrganizerTag } from './BotGroupPlan';
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  BOT_GROUP_SETTINGS_PARAM,
  botGroupErrorKey,
  botGroupPathBasename,
  isActiveBotGroupMember,
} from './botGroupPresentation';
import { botGroupApi, refreshBotGroups, useBotGroupList } from './botGroupStore';
import { useBotProfiles } from './botStore';

/** Route-owned drawer; returns null outside `/bots/groups/:groupId`. */
export function BotGroupSettingsDrawer() {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const match = matchPath('/bots/groups/:groupId', location.pathname);
  const { groups } = useBotGroupList();
  const group = groups.find((candidate) => candidate.id === match?.params.groupId) ?? null;
  const open = searchParams.get(BOT_GROUP_SETTINGS_PARAM) === '1' && group !== null;

  const close = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(BOT_GROUP_SETTINGS_PARAM);
        return next;
      },
      { replace: true },
    );
  };

  if (!group) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]">
          <Dialog.Content
            onPointerDownOutside={(event) => event.preventDefault()}
            aria-describedby={undefined}
            // CJK IME: Escape during composition only cancels the candidate.
            onEscapeKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229) event.preventDefault();
            }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--border-default)] bg-[var(--surface)] outline-none"
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
              <Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">
                {t('bots.groupChat.settings.title')}
              </Dialog.Title>
              <Tip text={t('bots.close')}>
                <Dialog.Close
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  aria-label={t('bots.close')}
                >
                  <X size={17} />
                </Dialog.Close>
              </Tip>
            </header>
            <BotGroupSettingsBody key={group.id} group={group} />
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BotGroupSettingsBody({ group }: { group: BotGroupSummary }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const bots = useBotProfiles();
  const [name, setName] = useState(group.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [replyModeError, setReplyModeError] = useState<string | null>(null);
  const [speakingModeError, setSpeakingModeError] = useState<string | null>(null);
  const [projectDirError, setProjectDirError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    'members' | 'organizer' | 'projectDir' | 'replyMode' | 'speakingMode' | 'delete' | null
  >(null);
  const [picking, setPicking] = useState(false);
  const nameFocusedRef = useRef(false);
  const savingNameRef = useRef(false);

  // Follow renames that land from main while the field is not being edited.
  useEffect(() => {
    if (!nameFocusedRef.current) setName(group.name);
  }, [group.name]);

  const memberIds = group.members.map((member) => member.botId);
  const addable = bots
    .filter(
      (bot) =>
        (bot.status ?? 'active') === 'active' &&
        bot.enabled !== false &&
        !memberIds.includes(bot.id),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const canRemove = group.members.length > BOT_GROUP_MIN_MEMBERS;
  const canAdd = group.members.length < BOT_GROUP_MAX_MEMBERS;

  /** Run a mutation; returns the failure copy, or null on success. */
  const mutate = async (
    run: (api: NonNullable<ReturnType<typeof botGroupApi>>) => Promise<BotGroupMutationResult>,
    fallbackKey: string,
  ): Promise<string | null> => {
    const api = botGroupApi();
    if (!api) return t(fallbackKey);
    const owner = getDataOwnerGeneration();
    try {
      const result = await run(api);
      if (!isDataOwnerGenerationCurrent(owner)) return null;
      if (!result.ok) return t(botGroupErrorKey(result.errorCode, fallbackKey));
      refreshBotGroups();
      return null;
    } catch {
      return t(fallbackKey);
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(group.name);
      setNameError(null);
      return;
    }
    if (trimmed === group.name || savingNameRef.current) return;
    savingNameRef.current = true;
    const failure = await mutate(
      (api) => api.updateBotGroup({ groupId: group.id, name: trimmed }),
      'bots.groupChat.settings.nameSaveFailed',
    );
    savingNameRef.current = false;
    setNameError(failure);
    if (failure) setName(group.name);
  };

  const setMembers = async (botIds: string[]) => {
    if (busy) return;
    setBusy('members');
    setMembersError(null);
    const failure = await mutate(
      (api) => api.setBotGroupMembers({ groupId: group.id, botIds }),
      'bots.groupChat.settings.membersSaveFailed',
    );
    setBusy(null);
    setMembersError(failure);
    if (!failure) setPicking(false);
  };

  const setOrganizer = async (organizerBotId: string) => {
    if (busy || organizerBotId === group.organizerBotId) return;
    setBusy('organizer');
    setMembersError(null);
    const failure = await mutate(
      (api) => api.updateBotGroup({ groupId: group.id, organizerBotId }),
      'bots.groupChat.settings.organizerSaveFailed',
    );
    setBusy(null);
    setMembersError(failure);
  };

  const setProjectDir = async (projectDir: string | null) => {
    setBusy('projectDir');
    setProjectDirError(null);
    const failure = await mutate(
      (api) => api.updateBotGroup({ groupId: group.id, projectDir }),
      'bots.groupChat.settings.projectDirSaveFailed',
    );
    setBusy(null);
    setProjectDirError(failure);
  };

  /** Same system folder picker as choosing a project for a new task; main re-validates. */
  const chooseProjectDir = async () => {
    if (busy) return;
    const dialog = window.electronAPI?.dialog;
    if (typeof dialog?.showOpenDirectory !== 'function') {
      setProjectDirError(t('bots.groupChat.settings.projectDirSaveFailed'));
      return;
    }
    setBusy('projectDir');
    setProjectDirError(null);
    let picked: string | null = null;
    try {
      const result = await dialog.showOpenDirectory(group.projectDir ? { defaultPath: group.projectDir } : undefined);
      picked = result.success ? result.path : null;
    } catch {
      setBusy(null);
      setProjectDirError(t('bots.groupChat.settings.projectDirSaveFailed'));
      return;
    }
    if (!picked || picked === group.projectDir) {
      setBusy(null);
      return;
    }
    await setProjectDir(picked);
  };

  const setReplyMode = async (replyMode: BotGroupReplyMode) => {
    if (busy || replyMode === group.replyMode) return;
    setBusy('replyMode');
    setReplyModeError(null);
    const failure = await mutate(
      (api) => api.updateBotGroup({ groupId: group.id, replyMode }),
      'bots.groupChat.settings.replyModeSaveFailed',
    );
    setBusy(null);
    setReplyModeError(failure);
  };

  const setSpeakingMode = async (speakingMode: BotGroupSpeakingMode) => {
    if (busy || speakingMode === group.speakingMode) return;
    setBusy('speakingMode');
    setSpeakingModeError(null);
    const failure = await mutate(
      (api) => api.updateBotGroup({ groupId: group.id, speakingMode }),
      'bots.groupChat.settings.speakingModeSaveFailed',
    );
    setBusy(null);
    setSpeakingModeError(failure);
  };

  const deleteGroup = async () => {
    if (busy) return;
    const confirmed = await confirm({
      presentation: 'standard',
      title: t('bots.groupChat.settings.deleteConfirmTitle', { name: group.name }),
      description: t('bots.groupChat.settings.deleteNote'),
      confirmText: t('bots.groupChat.settings.delete'),
      cancelText: t('bots.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('delete');
    setDeleteError(null);
    const failure = await mutate(
      (api) => api.deleteBotGroup(group.id),
      'bots.groupChat.settings.deleteFailed',
    );
    setBusy(null);
    if (failure) {
      setDeleteError(failure);
      return;
    }
    navigate('/bots', { replace: true });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <BotGroupAvatarStack members={group.members} size="md" max={4} />
          <p className="max-w-full truncate text-15 font-medium text-[var(--text-primary)]">{group.name}</p>
          <p className="-mt-1 text-12 text-[var(--text-tertiary)]">
            {t('bots.groupChat.memberCount', { count: group.members.length })}
          </p>
        </div>

        <FormField label={t('bots.groupChat.nameLabel')} error={nameError ?? undefined}>
          {(control) => (
            <Input
              {...control}
              size="md"
              value={name}
              maxLength={BOT_GROUP_NAME_MAX_CHARS}
              onChange={(value) => {
                setName(value);
                setNameError(null);
              }}
              onFocus={() => {
                nameFocusedRef.current = true;
              }}
              onBlur={() => {
                nameFocusedRef.current = false;
                void saveName();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                void saveName();
              }}
            />
          )}
        </FormField>

        <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-members">
          <h3 id="bot-group-settings-members" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('bots.groupChat.settings.members')}
          </h3>
          <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
            {group.members.map((member) => (
              <div
                key={member.botId}
                className="flex min-h-11 items-center gap-2.5 border-b border-[var(--border-default)] px-3 py-2 text-13 text-[var(--text-primary)]"
              >
                <BotAvatar bot={member} size="sm" className={isActiveBotGroupMember(member) ? undefined : 'opacity-60'} />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 truncate">{member.name}</span>
                  {member.botId === group.organizerBotId ? <BotGroupOrganizerTag /> : null}
                </span>
                {member.botId !== group.organizerBotId && isActiveBotGroupMember(member) ? (
                  <Button
                    type="button"
                    variant="secondary"
                    tone="quiet"
                    size="xs"
                    compact
                    disabled={busy !== null}
                    aria-label={t('bots.groupChat.settings.setOrganizerNamed', { name: member.name })}
                    onClick={() => void setOrganizer(member.botId)}
                  >
                    {t('bots.groupChat.settings.setOrganizer')}
                  </Button>
                ) : null}
                {!isActiveBotGroupMember(member) ? (
                  <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                    {t(
                      member.status === 'paused'
                        ? 'bots.groupChat.memberStatus.paused'
                        : 'bots.groupChat.memberStatus.unavailable',
                    )}
                  </span>
                ) : null}
                <Tip
                  text={canRemove ? null : t('bots.groupChat.settings.minMembers', { min: BOT_GROUP_MIN_MEMBERS })}
                >
                  <span className="inline-flex shrink-0">
                    <Button
                      type="button"
                      variant="secondary"
                      tone="quiet"
                      size="xs"
                      compact
                      disabled={!canRemove || busy !== null}
                      aria-label={t('bots.groupChat.settings.removeNamed', { name: member.name })}
                      onClick={() => void setMembers(memberIds.filter((id) => id !== member.botId))}
                    >
                      {t('bots.groupChat.settings.remove')}
                    </Button>
                  </span>
                </Tip>
              </div>
            ))}
            <button
              type="button"
              aria-expanded={picking}
              disabled={!canAdd || busy !== null}
              onClick={() => setPicking((value) => !value)}
              className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-13 text-[var(--text-secondary)] outline-none transition-colors enabled:hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--text-tertiary)]"
              >
                <Plus size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('bots.add')}</span>
              {!canAdd ? (
                <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                  {t('bots.groupChat.settings.maxMembers', { max: BOT_GROUP_MAX_MEMBERS })}
                </span>
              ) : null}
            </button>
            {picking && canAdd ? (
              <div className="flex flex-col gap-0.5 border-t border-[var(--border-default)] p-1">
                {addable.length === 0 ? (
                  <p className="px-2.5 py-2 text-12 text-[var(--text-tertiary)]">
                    {t('bots.groupChat.settings.noMoreBots')}
                  </p>
                ) : (
                  addable.map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setMembers([...memberIds, bot.id])}
                      className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-13 text-[var(--text-primary)] outline-none transition-colors enabled:hover:bg-[var(--model-item-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
                    >
                      <BotAvatar bot={bot} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                      <Plus size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <p className="text-12 leading-normal text-[var(--text-tertiary)]">
            {t('bots.groupChat.settings.organizerNote')}
          </p>
          {membersError ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {membersError}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-project">
          <h3 id="bot-group-settings-project" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('bots.groupChat.settings.projectDir')}
          </h3>
          <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
            <div
              data-testid="bot-group-project-dir"
              className="flex min-h-11 items-center gap-2.5 px-3 py-2 text-13 text-[var(--text-primary)]"
            >
              <Folder size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
              {group.projectDir ? (
                <Tip text={group.projectDir}>
                  <span className="min-w-0 flex-1 truncate">
                    {botGroupPathBasename(group.projectDir)}
                  </span>
                </Tip>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">
                  {t('bots.groupChat.settings.projectDirNone')}
                </span>
              )}
              {group.projectDir ? (
                <Button
                  type="button"
                  variant="secondary"
                  tone="quiet"
                  size="xs"
                  compact
                  disabled={busy !== null}
                  onClick={() => void setProjectDir(null)}
                >
                  {t('bots.groupChat.settings.projectDirClear')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                tone="quiet"
                size="xs"
                compact
                disabled={busy !== null}
                loading={busy === 'projectDir'}
                onClick={() => void chooseProjectDir()}
              >
                {t(
                  group.projectDir
                    ? 'bots.groupChat.settings.projectDirChange'
                    : 'bots.groupChat.settings.projectDirChoose',
                )}
              </Button>
            </div>
          </div>
          <p className="text-12 leading-normal text-[var(--text-tertiary)]">
            {t('bots.groupChat.settings.projectDirNote')}
          </p>
          {projectDirError ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {projectDirError}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-reply">
          <h3 id="bot-group-settings-reply" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('bots.groupChat.settings.replyMode')}
          </h3>
          <SegmentedControl<BotGroupReplyMode>
            aria-label={t('bots.groupChat.settings.replyMode')}
            value={group.replyMode}
            fullWidth
            disabled={busy !== null}
            options={[
              { value: 'all', label: t('bots.groupChat.settings.replyModeAll') },
              { value: 'mentioned', label: t('bots.groupChat.settings.replyModeMentioned') },
            ]}
            onValueChange={(value) => void setReplyMode(value)}
          />
          <p className="text-12 leading-normal text-[var(--text-tertiary)]">
            {t('bots.groupChat.settings.replyModeNote')}
          </p>
          {replyModeError ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {replyModeError}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-speaking">
          <h3 id="bot-group-settings-speaking" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('bots.groupChat.settings.speakingMode')}
          </h3>
          <SegmentedControl<BotGroupSpeakingMode>
            aria-label={t('bots.groupChat.settings.speakingMode')}
            value={group.speakingMode}
            fullWidth
            disabled={busy !== null}
            options={[
              { value: 'auto', label: t('bots.groupChat.settings.speakingModeAuto') },
              { value: 'sequential', label: t('bots.groupChat.settings.speakingModeSequential') },
            ]}
            onValueChange={(value) => void setSpeakingMode(value)}
          />
          <p className="text-12 leading-normal text-[var(--text-tertiary)]">
            {t(group.speakingMode === 'sequential'
              ? 'bots.groupChat.settings.speakingModeSequentialNote'
              : 'bots.groupChat.settings.speakingModeAutoNote')}
          </p>
          {speakingModeError ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {speakingModeError}
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void deleteGroup()}
              className={cn(
                'flex min-h-11 w-full items-center px-3 py-2 text-left text-13 font-medium text-[var(--text-danger)] outline-none transition-colors',
                'enabled:hover:bg-[var(--danger-bg-soft)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] disabled:opacity-60',
              )}
            >
              {t('bots.groupChat.settings.delete')}
            </button>
          </div>
          <p className="text-12 leading-normal text-[var(--text-tertiary)]">
            {t('bots.groupChat.settings.deleteNote')}
          </p>
          {deleteError ? (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {deleteError}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
