import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  personalDiscordChannelAccessSource,
  useDiscordChannelAccess,
  type DiscordChannelAccessSource,
  type DiscordGuilds,
} from '@/hooks/useDiscordChannelAccess';
import {
  enabledGuildCount,
  guildState,
  removeChannel,
  removeGuild,
  setChannelMembersAllowed,
  setChannelSelected,
  setGuildEnabled,
  setGuildMembersAllowed,
  setGuildMode,
  type DiscordGuildMode,
} from '@/lib/discordChannelAccess';

import { imBotSettings } from './ImBotSection.settings-search';

type Permissions = DiscordBotChannelPermissions;

/** 缺哪些非致命权限：机器人仍能回复，但流式编辑 / 卡片 / 文件之类会受限。 */
const LIMITED_PERMISSION_KEYS = ['readHistory', 'embed', 'attachFiles', 'sendInThreads'] as const;

function missingPermissionKeys(
  permissions: Permissions,
): Array<(typeof LIMITED_PERMISSION_KEYS)[number]> {
  return LIMITED_PERMISSION_KEYS.filter((key) => !permissions[key]);
}

/**
 * 「服务器频道」：每个服务器一行（名称 + 开关 + 摘要），默认全部关闭。
 * 首次开启 = 该服务器全部文字频道（包含之后新增的）；「更多设置」里可改成仅指定频道。
 * 不论哪种范围，都要直接 @ 机器人才会响应；频道里的话题随父频道准入，各自独立上下文。
 *
 * - 设置 → IM 机器人 → Discord（个人 bot）：只有主人。
 * - 伙伴设置 →「消息平台」某条 Discord 连接（传 `members`）：「更多设置」里多一个「允许频道成员使用」，默认关；
 *   开启后成员沿用该伙伴既有的权限、工具与共享记忆（见 cindy-bots-runtime.md）。白名单按连接各一份，
 *   `sourceKey` 是连接 id。
 */
export function DiscordChannelAccessSection({
  connected,
  source = personalDiscordChannelAccessSource,
  sourceKey = 'personal',
  members,
}: {
  connected: boolean;
  source?: DiscordChannelAccessSource;
  sourceKey?: string;
  members?: { botName: string };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { guilds, access, online, loading, error, update, reload } = useDiscordChannelAccess(
    connected,
    source,
    sourceKey,
  );

  const enabledCount = access ? enabledGuildCount(access) : null;
  const knownGuilds = useMemo(
    () => new Map((guilds ?? []).map((guild) => [guild.id, guild])),
    [guilds],
  );
  // 白名单里有、但当前连接已看不到的服务器 / 频道（被删 / 机器人被移出服务器）：留着会让人以为还开着。
  const unavailable = useMemo(() => {
    if (!guilds || !access) return [];
    const items: Array<{ guildId: string; channelId?: string }> = [];
    const seenGuilds = new Set<string>();
    const guildIds = [
      ...(access.guilds ?? []).map((guild) => guild.guildId),
      ...access.channels.map((channel) => channel.guildId),
    ];
    for (const guildId of guildIds) {
      if (seenGuilds.has(guildId)) continue;
      seenGuilds.add(guildId);
      const known = knownGuilds.get(guildId);
      if (!known) {
        items.push({ guildId });
        continue;
      }
      const knownChannels = new Set(known.channels.map((channel) => channel.id));
      const missing = new Set<string>();
      for (const channel of access.channels) {
        if (channel.guildId === guildId && !knownChannels.has(channel.channelId))
          missing.add(channel.channelId);
      }
      const entry = access.guilds?.find((guild) => guild.guildId === guildId);
      for (const channel of entry?.savedChannels ?? []) {
        if (!knownChannels.has(channel.channelId)) missing.add(channel.channelId);
      }
      for (const channelId of missing) items.push({ guildId, channelId });
    }
    return items;
  }, [access, guilds, knownGuilds]);

  if (!connected) return null;

  const toggleExpanded = (guildId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(guildId)) next.add(guildId);
      return next;
    });

  const modeOptions = (['all', 'selected'] as const).map((mode) => ({
    value: mode,
    label: t(`settings.discordBot.channels.guild.mode.${mode}`),
  }));

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] pt-3">
      <button
        data-setting-id={imBotSettings.discordChannels.id}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 bg-transparent p-0 text-left"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block text-13 font-medium text-[var(--settings-section-title)]">
            {t('settings.discordBot.channels.title')}
          </span>
          {/* 摘要只描述真实状态：读取中显示「读取中…」，读取失败 / 不支持时错误已在下面提示，不再留着加载摘要。 */}
          {(enabledCount !== null || (error !== 'load' && error !== 'unsupported')) && (
            <span className="block text-12 text-[var(--settings-section-desc)]">
              {enabledCount === null
                ? t('settings.discordBot.channels.summary.unknown')
                : enabledCount === 0
                  ? t('settings.discordBot.channels.summary.off')
                  : t('settings.discordBot.channels.summary.on', { count: enabledCount })}
            </span>
          )}
        </span>
        <span className="text-[var(--settings-section-desc)]">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-4">
          <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {t('settings.discordBot.channels.hint')}
          </p>
          <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
            {members
              ? t('settings.discordBot.channels.members.notice', { name: members.botName })
              : t('settings.discordBot.channels.ownerOnly')}
          </p>
          {!online && (
            <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]" role="status">
              {t('settings.discordBot.channels.offline')}
            </p>
          )}

          {error && (
            <ErrorNotice
              role="alert"
              message={t(`settings.discordBot.channels.error.${error}`)}
              actions={
                error === 'unsupported' ? undefined : (
                  <Button
                    data-settings-search-action="Reload the Discord server list after a failed read"
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={reload}
                  >
                    {t('settings.discordBot.channels.refresh')}
                  </Button>
                )
              }
              className="border-0 bg-transparent p-0"
            />
          )}

          {guilds === null && loading && (
            <div
              className="flex items-center gap-2 text-12 text-[var(--settings-section-desc)]"
              role="status"
            >
              <Spinner size={14} />
              {t('settings.discordBot.channels.loading')}
            </div>
          )}

          {guilds !== null && guilds.length === 0 && (
            <div className="flex flex-col gap-2 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
              <p>{t('settings.discordBot.channels.empty')}</p>
              <div>
                <Button
                  data-settings-search-action="Reload the Discord server list after inviting the bot to a server"
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={reload}
                  disabled={loading}
                >
                  <RefreshCw size={13} />
                  {t('settings.discordBot.channels.refresh')}
                </Button>
              </div>
            </div>
          )}

          {guilds !== null && access && guilds.length > 0 && (
            <SettingsSection>
              <SettingsCard>
                {guilds.map((guild) => (
                  <GuildRows
                    key={guild.id}
                    guild={guild}
                    state={guildState(access, guild.id)}
                    selectedCount={
                      access.channels.filter((channel) => channel.guildId === guild.id).length
                    }
                    expanded={expanded.has(guild.id)}
                    membersEnabled={!!members}
                    modeOptions={modeOptions}
                    channelMembers={(channelId) =>
                      access.channels.some(
                        (channel) =>
                          channel.guildId === guild.id &&
                          channel.channelId === channelId &&
                          channel.allowMembers === true,
                      )
                    }
                    onToggleExpanded={() => toggleExpanded(guild.id)}
                    onEnabled={(enabled) =>
                      update((current) => setGuildEnabled(current, guild.id, enabled))
                    }
                    onMode={(mode) => update((current) => setGuildMode(current, guild.id, mode))}
                    onChannel={(channelId, selected) =>
                      update((current) =>
                        setChannelSelected(current, guild.id, channelId, selected),
                      )
                    }
                    onGuildMembers={(allowed) =>
                      update((current) => setGuildMembersAllowed(current, guild.id, allowed))
                    }
                    onChannelMembers={(channelId, allowed) =>
                      update((current) =>
                        setChannelMembersAllowed(current, guild.id, channelId, allowed),
                      )
                    }
                  />
                ))}
              </SettingsCard>
            </SettingsSection>
          )}

          {unavailable.length > 0 && (
            <SettingsSection
              title={t('settings.discordBot.channels.unavailable.title')}
              caption={t('settings.discordBot.channels.unavailable.hint')}
            >
              <SettingsCard>
                {unavailable.map((item) => (
                  <SettingsRow
                    key={`${item.guildId}/${item.channelId ?? ''}`}
                    title={item.channelId ? `${item.guildId} / ${item.channelId}` : item.guildId}
                    trailing={
                      <Button
                        data-settings-search-action="Remove an unavailable Discord server or channel from the bot's allowlist"
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() =>
                          update((current) =>
                            item.channelId
                              ? removeChannel(current, item.guildId, item.channelId)
                              : removeGuild(current, item.guildId),
                          )
                        }
                      >
                        {t('settings.discordBot.channels.unavailable.remove')}
                      </Button>
                    }
                  />
                ))}
              </SettingsCard>
            </SettingsSection>
          )}
        </div>
      )}
    </div>
  );
}

/** 一个服务器：主行（名称 + 摘要 + 开关）+ 开启后的「更多设置」。 */
function GuildRows(props: {
  guild: DiscordGuilds[number];
  state: ReturnType<typeof guildState>;
  selectedCount: number;
  expanded: boolean;
  membersEnabled: boolean;
  modeOptions: Array<{ value: DiscordGuildMode; label: string }>;
  channelMembers: (channelId: string) => boolean;
  onToggleExpanded: () => void;
  onEnabled: (enabled: boolean) => void;
  onMode: (mode: DiscordGuildMode) => void;
  onChannel: (channelId: string, selected: boolean) => void;
  onGuildMembers: (allowed: boolean) => void;
  onChannelMembers: (channelId: string, allowed: boolean) => void;
}) {
  const { t } = useTranslation();
  const { guild, state } = props;
  const summary = !state.enabled
    ? t('settings.discordBot.channels.guild.summary.off')
    : state.mode === 'all'
      ? t('settings.discordBot.channels.guild.summary.all')
      : props.selectedCount > 0
        ? t('settings.discordBot.channels.guild.summary.selected', { count: props.selectedCount })
        : t('settings.discordBot.channels.guild.summary.none');
  return (
    <Fragment>
      <SettingsRow
        wrap
        title={guild.name}
        hint={summary}
        trailing={
          <span className="flex shrink-0 items-center gap-3">
            {state.enabled && (
              <Button
                data-settings-search-action="Expand the extra settings of one Discord server"
                variant="secondary"
                tone="quiet"
                size="sm"
                compact
                type="button"
                aria-expanded={props.expanded}
                onClick={props.onToggleExpanded}
              >
                {t('settings.discordBot.channels.guild.more')}
                {props.expanded ? (
                  <ChevronUp size={13} aria-hidden />
                ) : (
                  <ChevronDown size={13} aria-hidden />
                )}
              </Button>
            )}
            <Switch
              data-settings-search-action="Turn one Discord server on or off for the bot"
              checked={state.enabled}
              onCheckedChange={props.onEnabled}
              aria-label={t('settings.discordBot.channels.guild.toggleAria', { guild: guild.name })}
            />
          </span>
        }
      />
      {state.enabled && props.expanded && (
        <SettingsBlock className="flex flex-col gap-3">
          <SegmentedControl
            data-settings-search-action="Choose whether a Discord server covers all channels or only selected ones"
            aria-label={t('settings.discordBot.channels.guild.modeAria', { guild: guild.name })}
            value={state.mode}
            options={props.modeOptions}
            onValueChange={props.onMode}
            height={34}
            optionHeight={28}
            optionClassName="text-12"
          />
          {state.mode === 'all' ? (
            <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.discordBot.channels.guild.allHint')}
            </p>
          ) : null}
        </SettingsBlock>
      )}
      {state.enabled && props.expanded && state.mode === 'all' && props.membersEnabled && (
        <SettingsRow
          title={t('settings.discordBot.channels.members.label')}
          trailing={
            <Switch
              data-settings-search-action="Allow members of a whole Discord server to use the teammate"
              checked={state.allowMembers}
              onCheckedChange={props.onGuildMembers}
              aria-label={t('settings.discordBot.channels.members.guildAria', {
                guild: guild.name,
              })}
            />
          }
        />
      )}
      {state.enabled && props.expanded && state.mode === 'selected' && (
        <>
          {guild.channels.length === 0 ? (
            <SettingsRow title={t('settings.discordBot.channels.noTextChannels')} />
          ) : (
            guild.channels.map((channel) => {
              const canUse = channel.permissions.view && channel.permissions.send;
              const selected = state.selectedChannelIds.has(channel.id);
              const missing = missingPermissionKeys(channel.permissions);
              return (
                <Fragment key={channel.id}>
                  <SettingsRow
                    title={`#${channel.name}`}
                    hint={
                      !canUse
                        ? t('settings.discordBot.channels.permission.cannotSend')
                        : missing.length > 0
                          ? t('settings.discordBot.channels.permission.limited', {
                              list: missing
                                .map((key) => t(`settings.discordBot.channels.permission.${key}`))
                                .join(t('settings.discordBot.channels.permission.separator')),
                            })
                          : undefined
                    }
                    trailing={
                      <Switch
                        data-settings-search-action="Turn one Discord server channel on or off for the bot"
                        checked={selected}
                        // 已选的永远能取消；没有发言权限的频道不让新选（选了也答不了）。
                        disabled={!selected && !canUse}
                        onCheckedChange={(next) => props.onChannel(channel.id, next)}
                        aria-label={t('settings.discordBot.channels.toggleAria', {
                          guild: guild.name,
                          channel: channel.name,
                        })}
                      />
                    }
                  />
                  {props.membersEnabled && selected && (
                    <SettingsRow
                      title={t('settings.discordBot.channels.members.label')}
                      trailing={
                        <Switch
                          data-settings-search-action="Allow members of one Discord channel to use the teammate"
                          checked={props.channelMembers(channel.id)}
                          onCheckedChange={(next) => props.onChannelMembers(channel.id, next)}
                          aria-label={t('settings.discordBot.channels.members.aria', {
                            channel: channel.name,
                          })}
                        />
                      }
                    />
                  )}
                </Fragment>
              );
            })
          )}
        </>
      )}
    </Fragment>
  );
}
