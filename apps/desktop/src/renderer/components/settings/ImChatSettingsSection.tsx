/**
 * 个人 IM 机器人的「群聊」卡片（设置 → IM 机器人 → 某平台；Discord 叫「频道」）：版式照微信插件的
 * 「会话设置」（2026-11-24 主人裁决：要和微信插件一样）。飞书、Telegram、Discord、钉钉、企业微信同一份。
 *
 * - 收起时：图标、标题、「N 个群 · M 个单独设置」、一句说明和几个群头像，右边「展开」。打开平台页时只读概要
 *   （不解析项目模型）；第一次展开才读完整列表。
 * - 展开后：搜索框和一张群列表。一行一个群：头像、群名、「群聊」，右边一句状态（「demo-shop · 已单独设置 ·
 *   群成员可提问」；群成员被暂停时用警示色）。单独设置过的群排在前面（按打开或换群时的状态排，编辑中的群
 *   不跳动），不搜索时先显示 20 个。同一时间只展开一个群。
 * - 展开一个群：项目、模型、权限三格并排（窄时竖排），跟随时直接显示继承的值；模型单独设过时下面有「模型改回
 *   跟随」，权限第一项是「跟随 · 继承的档位」。下面是「群成员也能提问」与暂停时的「恢复」，最后一句生效说明。
 * - 放宽权限（含换项目带来的放宽、改成完全访问）先用 Cindy 的确认框写明是哪个群、从哪档变成哪档。
 */

import { ChevronDown, Hash, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { previewModelGroup, useModelGroups } from '@/features/model-groups/modelGroupsClient';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapse } from '@/components/ui/collapse';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SearchInput } from '@/components/ui/search-input';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingsCard, SettingsNotice } from '@/components/ui/settings-rows';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import {
  PLUGIN_ENGINE_FALLBACK_PERMISSION_MODES,
  type PluginEngineChoice,
  type PluginEngineSelection,
} from '@/lib/pluginEngineSelection';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  IM_CHAT_MEMBER_BREAKER_LIMIT,
  isWiderPermissionMode,
  type ImChatRoute,
  type ImChatSettingsChannel,
  type ImChatSettingsList,
  type ImChatSettingsPatch,
  type ImChatSettingsView,
} from '../../../shared/imChatSettings';
import {
  activeImDefaultAgentSettings,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultBuiltinAgentKind,
  type ImDefaultPermissionMode,
  type ImDefaultSettingsState,
} from '../../../shared/imDefaultSettings';
import type { ModelGroupSelection } from '../../../shared/modelGroups';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineEffort,
} from '../../../shared/pluginEngines';
import { useSettingsPluginEngines } from './useSettingsPluginEngines';

const FOLLOW = '__follow__';
const MISSING = '__missing__';
/** 不搜索时先显示的群数。 */
const LIST_LIMIT = 20;
/** 收起时露出的群头像数。 */
const STACK_LIMIT = 6;
const K = 'settings.imBot.chats';

function vendorKeyFor(agentKind: ImDefaultAgentKind): 'cc' | 'codex' | 'pi' {
  return agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'cc';
}

function agentKindOfVendor(vendor: string): ImDefaultBuiltinAgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor === 'pi' ? 'pi' : 'codex';
}

/** 各引擎在 IM 里可选的权限档（与新对话的权限选择同一套文案）。 */
function permissionModesFor(
  agentKind: ImDefaultAgentKind,
  pluginEngine?: PluginEngineChoice | null,
): ImDefaultPermissionMode[] {
  if (agentKind === 'acp') {
    const modes = (pluginEngine?.permissionModes ?? PLUGIN_ENGINE_FALLBACK_PERMISSION_MODES)
      .map((mode) => mode.id)
      .filter((id): id is ImDefaultPermissionMode => isImDefaultPermissionMode(id));
    return modes.length > 0 ? modes : ['ask', 'bypassPermissions'];
  }
  return agentKind === 'claude-code'
    ? ['ask', 'acceptEdits', 'auto', 'bypassPermissions']
    : ['ask', 'auto', 'bypassPermissions'];
}

function hasOverrides(chat: ImChatSettingsView): boolean {
  return Boolean(chat.project || chat.route || chat.permissionMode || chat.members);
}

function overriddenIds(chats: readonly ImChatSettingsView[]): ReadonlySet<string> {
  return new Set(chats.filter(hasOverrides).map((chat) => chat.chatId));
}

/** 渠道「新对话配置」此刻给出的路由（自动选择时是解析后的模型），群跟随时显示与继承的就是它。 */
function channelRoute(defaults: ImDefaultSettingsState): ImChatRoute {
  const agent = activeImDefaultAgentSettings(defaults);
  return {
    agentKind: defaults.agentKind,
    model: agent.model,
    providerId: agent.providerId,
    agentDeviceId: agent.agentDeviceId ?? null,
    effort: agent.effort,
    ...(defaults.modelGroup ? { modelGroup: defaults.modelGroup } : {}),
  };
}

/** 群没单独设权限、也不在项目里时的档位：飞书有「群聊新建任务权限档」，其他平台跟随机器人自己的。 */
function channelPermission(channel: ImChatSettingsChannel, defaults: ImDefaultSettingsState): ImDefaultPermissionMode {
  return channel === 'feishu' ? defaults.groupPermissionMode : defaults.permissionMode;
}

/** 名字的第一个字（头像占位）。 */
function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '#';
}

export function ImChatSettingsCard({ channel }: { channel: ImChatSettingsChannel }) {
  const { t } = useTranslation();
  const channels = channel === 'discord';
  const [open, setOpen] = useState(false);
  /** 收起时的概要（群数、单独设置数、头像）；读到完整列表后以列表为准。 */
  const [preview, setPreview] = useState<readonly ImChatSettingsView[] | null>(null);
  const [list, setList] = useState<ImChatSettingsList | null>(null);
  const [defaults, setDefaults] = useState<ImDefaultSettingsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const requestVersion = useRef(0);
  const requested = useRef(false);
  const pendingRef = useRef<string | null>(null);

  const load = useCallback((refresh = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadFailed(false);
    void Promise.all([
      window.electronAPI.maker.imChatSettingsList(channel, { refresh }),
      window.electronAPI.maker.imDefaultSettingsGet(channel),
    ])
      .then(([next, nextDefaults]) => {
        if (version !== requestVersion.current) return;
        setList(next);
        setDefaults(nextDefaults);
        setGrouped(overriddenIds(next.chats));
      })
      .catch(() => {
        if (version === requestVersion.current) setLoadFailed(true);
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, [channel]);

  // 打开平台页时读一次概要，收起状态就能看到有哪些群；读不到就只显示说明。
  useEffect(() => {
    const read = window.electronAPI.maker?.imChatSettingsList;
    if (typeof read !== 'function') return;
    let alive = true;
    void read(channel, { summary: true })
      .then((next) => {
        if (alive) setPreview(next.chats);
      })
      .catch(() => {
        // 概要只是提示; 展开时的完整读取会报出失败。
      });
    return () => {
      alive = false;
    };
  }, [channel]);

  // 第一次展开才读完整列表; 之后用「刷新」。
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    load();
  }, [open, load]);

  useEffect(() => () => {
    requestVersion.current++;
  }, []);

  const applyView = (next: ImChatSettingsView) =>
    setList((current) =>
      current
        ? {
            ...current,
            chats: current.chats.map((item) =>
              item.chatId === next.chatId ? { ...next, avatarUrl: next.avatarUrl ?? item.avatarUrl } : item,
            ),
          }
        : current,
    );

  const run = useCallback(
    async (chat: ImChatSettingsView, action: () => Promise<ImChatSettingsView>, failure: string): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = chat.chatId;
      setPending(chat.chatId);
      try {
        applyView(await action());
        return true;
      } catch {
        toast.error(t(failure));
        return false;
      } finally {
        pendingRef.current = null;
        setPending(null);
      }
    },
    [t],
  );

  const save = (chat: ImChatSettingsView, patch: ImChatSettingsPatch) =>
    run(chat, () => window.electronAPI.maker.imChatSettingsSet(channel, chat.chatId, patch, chat.name), `${K}.saveFailed`);
  const resume = (chat: ImChatSettingsView) =>
    run(chat, () => window.electronAPI.maker.imChatSettingsResumeMembers(channel, chat.chatId, chat.name), `${K}.members.resumeFailed`);

  const toggleChat = (chatId: string) => {
    const opening = expanded !== chatId;
    setExpanded(opening ? chatId : null);
    // 关上或换一个群时才按最新设置重新排，编辑中的群留在原位。
    if (list) setGrouped(overriddenIds(list.chats));
    // 跟随时显示的是渠道此刻的值：展开时重读一次，刚在「模型」里改过也能对上。
    if (opening) {
      const version = requestVersion.current;
      void window.electronAPI.maker
        .imDefaultSettingsGet(channel)
        .then((next) => {
          if (version === requestVersion.current) setDefaults(next);
        })
        .catch(() => {
          // 读不到就沿用上次的值；保存时 Main 按实时设置解析。
        });
    }
  };

  const chatName = (chat: ImChatSettingsView) =>
    chat.name ?? t(chat.kind === 'channel' ? `${K}.unnamedChannel` : `${K}.unnamed`, { id: chat.chatId.slice(-6) });

  const headerChats = list?.chats ?? preview ?? [];
  const customCount = headerChats.filter(hasOverrides).length;
  const countText = headerChats.length === 0
    ? null
    : [
        t(channels ? `${K}.channelCount` : `${K}.groupCount`, { count: headerChats.length }),
        customCount > 0 ? t(`${K}.customCount`, { count: customCount }) : null,
      ].filter(Boolean).join(' · ');

  const needle = query.trim().toLocaleLowerCase();
  const searching = needle.length > 0;
  const ordered = [...(list?.chats ?? [])].sort((a, b) => Number(grouped.has(b.chatId)) - Number(grouped.has(a.chatId)));
  const matched = ordered.filter((chat) => !searching || chatName(chat).toLocaleLowerCase().includes(needle));
  const shown = searching ? matched : matched.slice(0, LIST_LIMIT);
  const title = t(channels ? 'settings.imBot.rows.channels' : 'settings.imBot.rows.chats');
  const remoteList = channel === 'feishu' || channels;

  return (
    <SettingsCard data-im-chat-card={channel}>
      <div
        className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 min-[520px]:grid-cols-[auto_minmax(0,1fr)_auto]"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mt-0.5 flex h-7 w-7 items-center justify-center self-start text-[var(--text-secondary)]" aria-hidden>
          {channels ? <Hash size={20} /> : <Users size={20} />}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-13 font-medium leading-[1.45] text-[var(--text-primary)]">{title}</h3>
            {countText && <span className="text-12 leading-[1.5] tabular-nums text-[var(--text-secondary)]">{countText}</span>}
          </div>
          <p className="mt-0.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
            {t(channels ? `${K}.descriptionChannels` : `${K}.description`)}
          </p>
          {!open && headerChats.length > 0 && <AvatarStack chats={headerChats} name={chatName} />}
        </div>
        <div
          className="col-start-2 flex flex-wrap items-center gap-2 justify-self-start min-[520px]:col-start-3 min-[520px]:justify-self-end"
          onClick={(event) => event.stopPropagation()}
        >
          {open && (
            <Button data-settings-search-action="Refresh the group list" size="sm" variant="secondary" disabled={loading}
              onClick={() => load(true)}>
              <RefreshCw size={14} aria-hidden />
              {t(`${K}.refresh`)}
            </Button>
          )}
          <Button
            data-settings-search-action="Expand or collapse the group list"
            size="sm"
            variant="secondary"
            className="rounded-full"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? `${K}.collapse` : `${K}.expand`)}
            <ChevronDown size={14} aria-hidden
              className={cn('text-[var(--text-secondary)] transition-transform duration-[var(--motion-fast)]', open && 'rotate-180')} />
          </Button>
        </div>
      </div>
      <Collapse open={open}>
        {open && (
          <div className="flex flex-col gap-3 px-4 pb-4">
            {loadFailed ? (
              <SettingsNotice tone="error">{t(`${K}.loadFailed`)}</SettingsNotice>
            ) : !list ? (
              <p className="text-12 text-[var(--text-tertiary)]">{t(`${K}.loading`)}</p>
            ) : (
              <>
                {/* 只有飞书 / Discord 的名单要连上平台才读得到; 其他平台的名单本来就来自本机记录。 */}
                {!list.connected && remoteList && <SettingsNotice>{t(`${K}.notConnected`)}</SettingsNotice>}
                {list.listError && (
                  <SettingsNotice>
                    {t(list.listError === 'permission' && channel === 'feishu' ? `${K}.listPermission` : `${K}.listUnavailable`)}
                  </SettingsNotice>
                )}
                {list.chats.length > 0 && (
                  <SearchInput
                    data-settings-search-action="Filter groups in the current list"
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t(`${K}.searchLabel`)}
                    placeholder={t(channels ? `${K}.searchPlaceholderChannels` : `${K}.searchPlaceholder`)}
                  />
                )}
                {shown.length > 0 && (
                  <div className="overflow-hidden rounded-[8px] border border-[var(--settings-theme-card-border)]" role="group" aria-label={title}>
                    {shown.map((chat) => (
                      <ChatRow
                        key={chat.chatId}
                        channel={channel}
                        chat={chat}
                        name={chatName(chat)}
                        open={expanded === chat.chatId}
                        list={list}
                        defaults={defaults}
                        disabled={pending !== null}
                        onToggle={() => toggleChat(chat.chatId)}
                        onSave={(patch) => save(chat, patch)}
                        onResume={() => void resume(chat)}
                      />
                    ))}
                  </div>
                )}
                {!searching && matched.length > shown.length && (
                  <p className="text-12 text-[var(--text-secondary)]">{t(`${K}.shownHint`, { shown: shown.length, total: matched.length })}</p>
                )}
                {searching && matched.length === 0 && (
                  <p className="text-12 text-[var(--text-secondary)]">{t(`${K}.noMatch`, { query: query.trim() })}</p>
                )}
                {list.chats.length === 0 && (list.connected || !remoteList) && (
                  <p className="text-12 text-[var(--text-secondary)]">
                    {t(channels ? `${K}.emptyChannels` : channel === 'feishu' ? `${K}.empty` : `${K}.emptyLocal`)}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Collapse>
    </SettingsCard>
  );
}

/** 平台给的群头像（飞书）；没有时用群名第一个字。 */
function ChatAvatar({ chat, name, size }: { chat: ImChatSettingsView; name: string; size: 'row' | 'stack' }) {
  const [failed, setFailed] = useState(false);
  const shape = cn(
    'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-chip)] font-semibold text-[var(--text-secondary)]',
    size === 'row' ? 'h-6 w-6 text-10' : 'h-7 w-7 text-11 ring-2 ring-[var(--settings-theme-card-bg)]',
  );
  if (chat.avatarUrl && !failed) {
    return (
      <img src={chat.avatarUrl} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer"
        onError={() => setFailed(true)} className={cn(shape, 'object-cover')} />
    );
  }
  return <span className={shape} aria-hidden>{chat.kind === 'channel' ? <Hash size={size === 'row' ? 12 : 13} /> : initialOf(name)}</span>;
}

function AvatarStack({ chats, name }: { chats: readonly ImChatSettingsView[]; name: (chat: ImChatSettingsView) => string }) {
  const shown = chats.slice(0, STACK_LIMIT);
  const rest = chats.length - shown.length;
  return (
    <div className="mt-2.5 flex items-center" aria-hidden>
      <div className="flex -space-x-1.5">
        {shown.map((chat) => <ChatAvatar key={chat.chatId} chat={chat} name={name(chat)} size="stack" />)}
      </div>
      {rest > 0 && <span className="ml-2 text-12 tabular-nums text-[var(--text-secondary)]">+{rest}</span>}
    </div>
  );
}

/** 行右边那句状态：项目 · 已单独设置 · 群成员可提问；什么都没设就是「跟随机器人」。 */
function statusOf(t: (key: string, vars?: Record<string, unknown>) => string, chat: ImChatSettingsView): { text: string; warning: boolean } {
  const parts = [
    chat.project ? (chat.project.available ? chat.project.name : t(`${K}.project.missing`, { name: chat.project.name })) : null,
    chat.route || chat.permissionMode ? t(`${K}.statusCustom`) : null,
    chat.members ? t(chat.membersPaused ? `${K}.members.pausedChip` : `${K}.members.chip`) : null,
  ].filter((part): part is string => Boolean(part));
  return {
    text: parts.length > 0 ? parts.join(' · ') : t(`${K}.project.follow`),
    warning: chat.membersPaused || (chat.project !== null && !chat.project.available),
  };
}

function ChatRow({
  channel,
  chat,
  name,
  open,
  list,
  defaults,
  disabled,
  onToggle,
  onSave,
  onResume,
}: {
  channel: ImChatSettingsChannel;
  chat: ImChatSettingsView;
  name: string;
  open: boolean;
  list: ImChatSettingsList;
  defaults: ImDefaultSettingsState | null;
  disabled: boolean;
  onToggle: () => void;
  onSave: (patch: ImChatSettingsPatch) => Promise<boolean>;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const status = statusOf(t, chat);
  return (
    <div className="border-t border-[var(--settings-theme-card-border)] first:border-t-0" data-im-chat={chat.chatId}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(`${K}.expandAria`, { name })}
        onClick={onToggle}
        className={cn(
          // 窄时状态换到群名下面, 不把群名挤成一列一个字。
          'grid min-h-11 w-full grid-cols-[minmax(0,1fr)_14px] items-center gap-x-2.5 gap-y-0.5 px-3 py-2 text-left min-[520px]:grid-cols-[minmax(0,1fr)_minmax(0,auto)_14px] outline-none transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover-soft)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
          open && 'bg-[var(--surface-hover-soft)]',
        )}
      >
        <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
          <ChatAvatar chat={chat} name={name} size="row" />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-13 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]">{name}</span>
            <span className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t(chat.kind === 'channel' ? `${K}.kindChannel` : `${K}.kindGroup`)}
            </span>
          </span>
        </span>
        <span className={cn(
          'col-start-1 row-start-2 pl-8 text-left text-12 leading-[1.5] [overflow-wrap:anywhere] min-[520px]:col-start-2 min-[520px]:row-start-1 min-[520px]:max-w-[220px] min-[520px]:pl-0 min-[520px]:text-right',
          status.warning ? 'text-[var(--warning-fg)]' : 'text-[var(--text-secondary)]',
        )}>
          {status.text}
        </span>
        <ChevronDown size={14} aria-hidden
          className={cn('col-start-2 row-start-1 text-[var(--text-secondary)] transition-transform duration-[var(--motion-fast)] min-[520px]:col-start-3', open && 'rotate-180')} />
      </button>
      <Collapse open={open}>
        {open && defaults && (
          <ChatEditor channel={channel} chat={chat} name={name} list={list} defaults={defaults} disabled={disabled}
            onSave={onSave} onResume={onResume} />
        )}
      </Collapse>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="text-12 leading-[1.5] text-[var(--text-secondary)]">{label}</span>
      {children}
    </div>
  );
}

function ChatEditor({
  channel,
  chat,
  name,
  list,
  defaults,
  disabled,
  onSave,
  onResume,
}: {
  channel: ImChatSettingsChannel;
  chat: ImChatSettingsView;
  name: string;
  list: ImChatSettingsList;
  defaults: ImDefaultSettingsState;
  disabled: boolean;
  onSave: (patch: ImChatSettingsPatch) => Promise<boolean>;
  onResume: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const projects = list.projects;
  // 跟随的来源：群选了项目（或跟随机器人自己的项目）、且「项目与模型」里对得上那一行时跟随项目，
  // 否则跟随渠道设置。
  const channelProject = list.channelProject?.available ? list.channelProject : null;
  const followedProject = chat.project
    ? chat.project.available && chat.project.config ? { name: chat.project.name, ...chat.project.config } : null
    : channelProject?.config ? { name: channelProject.name, ...channelProject.config } : null;
  const inheritedRoute = followedProject
    ? followedProject.route ?? { ...channelRoute(defaults), model: '' }
    : channelRoute(defaults);
  const route = chat.route ?? inheritedRoute;
  const customizedRoute = chat.route !== null;
  const isPluginEngineRoute = route.agentKind === 'acp' && !!route.providerId;
  const agentDeviceId = route.agentDeviceId;
  const builtinAgentDeviceId = isPluginEngineRoute ? null : agentDeviceId;
  const routeDevices = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: builtinAgentDeviceId });
  const settingsPluginEngines = useSettingsPluginEngines(isPluginEngineRoute ? agentDeviceId : null);
  const activePluginEngine = isPluginEngineRoute
    ? settingsPluginEngines.engines.find(
        (engine) =>
          engine.providerId === route.providerId &&
          (engine.deviceId ?? null) === (agentDeviceId ?? null),
      ) ?? null
    : null;
  const pickerAgents = useModelPickerAgents(
    route.agentKind === 'acp' ? 'claude-code' : route.agentKind,
    builtinAgentDeviceId,
  );
  const showPluginEngines = settingsPluginEngines.hasSources || isPluginEngineRoute;
  const { config: modelGroupsConfig } = useModelGroups();
  const lastUnifiedRouteRef = useRef<ImChatRoute | null>(null);

  const projectOptions: SelectOption[] = [
    {
      value: FOLLOW,
      label: list.channelProject
        ? t(`${K}.project.followWith`, { project: list.channelProject.name })
        : t(`${K}.project.follow`),
    },
    ...(chat.project && !chat.project.available
      ? [{ value: MISSING, label: t(`${K}.project.missing`, { name: chat.project.name }), disabled: true }]
      : []),
    ...projects.map((project) => ({ value: project.token, label: project.name })),
  ];
  const projectValue = chat.project ? (chat.project.available ? chat.project.token : MISSING) : FOLLOW;

  // 渠道是「自动选择」却暂时没有可用模型时，继承来的模型是空的，不能拿它存成群设置。
  const saveRoute = (next: ImChatRoute) => (next.model.trim() ? onSave({ route: next }) : false);
  const selectChatModelGroup = async (selection: ModelGroupSelection) => {
    const item = modelGroupsConfig.routes.find((r) => r.id === selection.id);
    const preview = await previewModelGroup(selection);
    if (preview?.outcome !== 'routed') {
      toast.warning(t('modelGroups.picker.chooseUnavailable', { name: item?.name ?? '' }));
      return;
    }
    const agentKind: ImDefaultAgentKind =
      preview.route.agentKind === 'cc' ? 'claude-code' : preview.route.agentKind;
    await saveRoute({
      agentKind,
      model: preview.route.model || (agentKind === 'acp' ? PLUGIN_ENGINE_DEFAULT_MODEL : ''),
      providerId: preview.route.providerId,
      agentDeviceId: preview.route.agentDeviceId ?? null,
      effort: agentKind === 'acp'
        ? (isImDefaultEffort(preview.route.effort) ? preview.route.effort : '')
        : (isImDefaultEffort(preview.route.effort) ? preview.route.effort : (isImDefaultEffort(route.effort) ? route.effort : 'high')),
      modelGroup: selection.id,
    });
  };

  const fallbackPermission = channelPermission(channel, defaults);
  const inheritedPermission = followedProject?.permissionMode ?? fallbackPermission;
  const effectivePermission = chat.permissionMode ?? inheritedPermission;
  const permissionLabel = (mode: string) => {
    const key = `newChat.permissionSelector.modes.${route.agentKind}.${mode}.label`;
    return i18n.exists(key) ? t(key) : mode;
  };
  const modes = permissionModesFor(route.agentKind, activePluginEngine);
  if (chat.permissionMode && !modes.includes(chat.permissionMode)) modes.push(chat.permissionMode);
  const permissionOptions: SelectOption[] = [
    { value: FOLLOW, label: t(`${K}.permission.followWith`, { mode: permissionLabel(inheritedPermission) }) },
    ...modes.map((mode) => ({ value: mode, label: permissionLabel(mode) })),
  ];

  const confirmWiderPermission = (next: ImDefaultPermissionMode) =>
    !isWiderPermissionMode(next, effectivePermission) ||
    confirm({
      title: t(`${K}.widerConfirm.title`, { name }),
      description: t(`${K}.widerConfirm.description`, {
        current: permissionLabel(effectivePermission),
        next: permissionLabel(next),
      }),
      confirmText: t(`${K}.widerConfirm.confirm`),
      cancelText: t(`${K}.widerConfirm.cancel`),
      confirmVariant: 'destructive',
    });

  const changeProject = async (value: string) => {
    if (value === MISSING || value === projectValue) return;
    const token = value === FOLLOW ? null : value;
    const next =
      chat.permissionMode ??
      (token
        ? projects.find((project) => project.token === token)?.permissionMode
        : channelProject?.config?.permissionMode) ??
      fallbackPermission;
    if (await confirmWiderPermission(next)) await onSave({ projectToken: token });
  };
  const changePermission = async (value: string) => {
    if (value === FOLLOW) {
      if (chat.permissionMode === null) return;
      if (await confirmWiderPermission(inheritedPermission)) await onSave({ permissionMode: null });
      return;
    }
    if (!isImDefaultPermissionMode(value) || value === chat.permissionMode) return;
    if (value === 'bypassPermissions') {
      const confirmed = await confirm({
        title: t(`${K}.fullAccessConfirm.title`, { name }),
        description: t(`${K}.fullAccessConfirm.description`),
        confirmText: t(`${K}.fullAccessConfirm.confirm`),
        cancelText: t(`${K}.fullAccessConfirm.cancel`),
        confirmVariant: 'destructive',
      });
      if (!confirmed) return;
    } else if (!(await confirmWiderPermission(value))) return;
    await onSave({ permissionMode: value });
  };

  const vars = { limit: IM_CHAT_MEMBER_BREAKER_LIMIT };
  return (
    <div
      data-im-chat-editor={chat.chatId}
      className="grid grid-cols-1 gap-x-3 gap-y-2.5 border-t border-[var(--settings-theme-card-border)] px-3 pb-3 pt-2.5 min-[520px]:grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)_minmax(0,1.15fr)]"
    >
      <Field label={t(`${K}.project.label`)}>
        <Select label={t(`${K}.project.label`)} value={projectValue} options={projectOptions} width="full"
          disabled={disabled} onValueChange={(value) => void changeProject(value)} />
      </Field>
      <Field label={t(`${K}.model.label`)}>
        <ModelSelector
          remoteAgent={routeDevices.devices && { devices: routeDevices.devices, selectedDeviceId: builtinAgentDeviceId }}
          deviceId={builtinAgentDeviceId ?? undefined}
          agentDevice={
            builtinAgentDeviceId
              ? { deviceId: builtinAgentDeviceId, name: routeDevices.devices?.find((device) => device.deviceId === builtinAgentDeviceId)?.name ?? null }
              : null
          }
          fastModeConfigurable={false}
          unifiedAgents={pickerAgents}
          pluginEngines={showPluginEngines ? {
            engines: settingsPluginEngines.engines,
            active: isPluginEngineRoute && route.model
              ? {
                  providerId: route.providerId!,
                  ...(agentDeviceId ? { deviceId: agentDeviceId } : {}),
                  modelId: route.model,
                  ...(isPluginEngineEffort(route.effort) ? { effort: route.effort } : {}),
                }
              : null,
            readCatalogue: settingsPluginEngines.readCatalogue,
            onSelect: (selection: PluginEngineSelection) => {
              void saveRoute({
                agentKind: 'acp',
                providerId: selection.providerId,
                model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
                agentDeviceId: selection.deviceId ?? null,
                effort: selection.effort ?? '',
                modelGroup: null,
              });
            },
          } : undefined}
          // 跟随时显示的是继承来的模型；点它也要落成这个群的设置（同 IM 工作区偏好）。
          reselectEmitsChange
          modelGroups={{
            config: modelGroupsConfig,
            active: route.modelGroup && modelGroupsConfig.routes.some((r) => r.id === route.modelGroup)
              ? { type: 'route', id: route.modelGroup }
              : null,
            onSelect: (selection) => { void selectChatModelGroup(selection); },
            onAttach: (selection) => {
              const last = lastUnifiedRouteRef.current;
              lastUnifiedRouteRef.current = null;
              if (last) void saveRoute({ ...last, modelGroup: selection.id });
            },
            onManage: () => { window.location.hash = '#/settings?tab=model-groups'; },
          }}
          onUnifiedSelect={({ engine, modelId, providerId, effort, agentDevice }) => {
            const next: ImChatRoute = {
              agentKind: agentKindOfVendor(engine),
              model: modelId,
              providerId,
              agentDeviceId: agentDevice?.deviceId ?? null,
              effort: isImDefaultEffort(effort) ? effort : (isImDefaultEffort(route.effort) ? route.effort : 'high'),
              modelGroup: null,
            };
            lastUnifiedRouteRef.current = next;
            return saveRoute(next);
          }}
          modelId={route.model}
          effort={route.effort}
          onModelChange={(modelId) => saveRoute({ ...route, model: modelId, modelGroup: null })}
          onEffortChange={(effort) => {
            if (!isImDefaultEffort(effort) || (customizedRoute && effort === route.effort)) return;
            return saveRoute({ ...route, effort });
          }}
          onProviderChange={(providerId, modelId, reconciledEffort) =>
            saveRoute({
              ...route,
              providerId,
              model: modelId ?? route.model,
              effort: isImDefaultEffort(reconciledEffort) ? reconciledEffort : route.effort,
              modelGroup: null,
            })
          }
          vendorKey={vendorKeyFor(route.agentKind)}
          currentProviderId={isPluginEngineRoute ? null : route.providerId}
          switching={disabled}
          triggerVariant="field"
          popoverSide="bottom"
          ariaContext={`${t(`${K}.model.label`)} · ${name}`}
        />
        {customizedRoute && (
          <button type="button" disabled={disabled} onClick={() => void onSave({ route: null })}
            className="justify-self-start text-12 leading-[1.5] text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-45">
            {t(`${K}.model.reset`)}
          </button>
        )}
      </Field>
      <Field label={t(`${K}.permission.label`)}>
        <Select label={t(`${K}.permission.label`)} value={chat.permissionMode ?? FOLLOW} options={permissionOptions}
          width="full" disabled={disabled} onValueChange={(value) => void changePermission(value)} />
      </Field>
      <label className="col-span-full grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2 py-0.5">
        <Checkbox className="mt-0.5" checked={chat.members} disabled={disabled}
          onChange={(event) => void onSave({ members: event.currentTarget.checked })} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-13 leading-[1.5] text-[var(--text-primary)]">{t(`${K}.members.label`)}</span>
          <span className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${K}.members.hint`)}</span>
          <span className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${K}.members.guard`, vars)}</span>
        </span>
      </label>
      {chat.members && chat.membersPaused && (
        <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 pl-6">
          <span className="min-w-[200px] flex-1 text-12 leading-[1.5] text-[var(--warning-fg)]" role="status">
            {t(`${K}.members.paused`, vars)}
          </span>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={onResume}>{t(`${K}.members.resume`)}</Button>
        </div>
      )}
      <p className="col-span-full text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${K}.fieldsNote`)}</p>
    </div>
  );
}
