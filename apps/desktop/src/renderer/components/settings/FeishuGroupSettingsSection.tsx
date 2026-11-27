/**
 * 个人飞书 / Lark 机器人卡片里的「群聊」：给机器人所在的某个群单独指定项目、模型（含推理强度）与权限。
 *
 * 整块默认收起（同 IM 渠道卡片的折叠写法）。打开飞书卡片时读一次概要，收起状态就在标题旁显示群数、
 * 单独设置数与几个群头像，不必先展开一次；概要不解析项目模型，第一次展开才读完整列表（群名单与
 * 概要共用主进程 30 秒内的结果，不重复向飞书请求）。
 *
 * 列表分两组：单独设置过的群在上，跟随渠道设置的群在下（多于 5 个时先显示 4 个）；群多时可按群名
 * 搜索。分组按打开列表或展开另一个群时的状态排，正在编辑的群不会因为保存而在两组之间跳动。
 *
 * 每一项默认跟随：项目跟随机器人的对话目录；绑定了项目的群，模型与权限跟随「项目与模型」里那个
 * 项目的一行，没绑项目的群模型跟随「新对话配置」、权限跟随「群聊新建任务权限档」。跟随时控件直接
 * 显示正在继承的值，在控件里改任何一项（包括只改推理强度）就成为这个群的单独设置；「已自定义」
 * 旁的恢复按钮改回跟随。项目与权限在群里新建任务或 `/new` 时生效；模型让群里仍跟随默认的任务在
 * 下一条消息时换过去。把一个群改成「完全访问」、或换项目会让群里新任务的权限变宽时，先用 Cindy 的
 * 确认框写明是哪个群、从哪档变成哪档。
 */

import { ChevronDown, FolderOpen, RefreshCw, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { previewModelGroup, useModelGroups } from '@/features/model-groups/modelGroupsClient';
import type { ModelGroupSelection } from '../../../shared/modelGroups';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingsCard, SettingsNotice, SettingsRow } from '@/components/ui/settings-rows';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  isWiderPermissionMode,
  type FeishuGroupRoute,
  type FeishuGroupSettingsList,
  type FeishuGroupSettingsPatch,
  type FeishuGroupSettingsView,
} from '../../../shared/feishuGroupSettings';
import {
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultPermissionMode,
  type ImDefaultSettingsState,
} from '../../../shared/imDefaultSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { imBotSettings } from './ImBotSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

const FOLLOW = '__follow__';
const MISSING = '__missing__';
/** 跟随组先显示的行数；只多出一行时不折叠。 */
const FOLD = 4;
/** 群数超过这个值才显示搜索框。 */
const SEARCH_MIN_GROUPS = 8;

function vendorKeyFor(agentKind: ImDefaultAgentKind): 'cc' | 'codex' | 'pi' {
  return agentKind === 'claude-code' ? 'cc' : agentKind;
}

function agentKindOfVendor(vendor: string): ImDefaultAgentKind {
  return vendor === 'cc' ? 'claude-code' : vendor === 'pi' ? 'pi' : 'codex';
}

function hasOverrides(group: FeishuGroupSettingsView): boolean {
  return Boolean(group.project || group.route || group.permissionMode);
}

function overriddenIds(groups: readonly FeishuGroupSettingsView[]): ReadonlySet<string> {
  return new Set(groups.filter(hasOverrides).map((group) => group.chatId));
}

/** 渠道「新对话配置」此刻给出的路由（自动选择时是解析后的模型），群跟随时显示与继承的就是它。 */
function channelRoute(channel: ImDefaultSettingsState): FeishuGroupRoute {
  const agent = channel.agents[channel.agentKind];
  return {
    agentKind: channel.agentKind,
    model: agent.model,
    providerId: agent.providerId,
    agentDeviceId: agent.agentDeviceId ?? null,
    effort: agent.effort,
  };
}

export function FeishuGroupSettingsSection() {
  const { t } = useTranslation();
  const groupSetting = useSettingDefinition(imBotSettings.feishuGroups);
  const [list, setList] = useState<FeishuGroupSettingsList | null>(null);
  /** 收起时的概要（群数、单独设置数、头像）；读到完整列表后以列表为准。 */
  const [preview, setPreview] = useState<readonly FeishuGroupSettingsView[] | null>(null);
  const [channel, setChannel] = useState<ImDefaultSettingsState | null>(null);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const requestVersion = useRef(0);
  const requested = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const titleId = `${baseId}-title`;
  const panelId = `${baseId}-panel`;
  const toggleSection = () => setSectionOpen((value) => !value);

  const load = useCallback((refresh = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadFailed(false);
    void Promise.all([
      window.electronAPI.maker.feishuGroupSettingsList({ refresh }),
      window.electronAPI.maker.imDefaultSettingsGet('feishu'),
    ])
      .then(([next, defaults]) => {
        if (version !== requestVersion.current) return;
        setList(next);
        setChannel(defaults);
        setGrouped(overriddenIds(next.groups));
      })
      .catch(() => {
        if (version === requestVersion.current) setLoadFailed(true);
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, []);

  // 打开飞书卡片（本块挂载）时读一次概要，收起状态也能看到有哪些群；读不到就不显示概要。
  useEffect(() => {
    let alive = true;
    void window.electronAPI.maker
      .feishuGroupSettingsList({ summary: true })
      .then((next) => {
        if (alive) setPreview(next.groups);
      })
      .catch(() => {
        // 概要只是提示；展开时的完整读取会报出失败。
      });
    return () => {
      alive = false;
    };
  }, []);

  // 第一次展开才读完整列表；读失败后用「刷新」重试。
  useEffect(() => {
    if (!sectionOpen || requested.current) return;
    requested.current = true;
    load();
  }, [sectionOpen, load]);

  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [],
  );

  const save = useCallback(
    async (group: FeishuGroupSettingsView, patch: FeishuGroupSettingsPatch): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = group.chatId;
      setPending(group.chatId);
      try {
        const next = await window.electronAPI.maker.feishuGroupSettingsSet(group.chatId, patch, group.name);
        setList((current) =>
          current
            ? {
                ...current,
                groups: current.groups.map((item) =>
                  item.chatId === next.chatId ? { ...next, avatarUrl: next.avatarUrl ?? item.avatarUrl } : item,
                ),
              }
            : current,
        );
        return true;
      } catch {
        toast.error(t('settings.feishuBot.groups.saveFailed'));
        return false;
      } finally {
        pendingRef.current = null;
        setPending(null);
      }
    },
    [t],
  );

  const toggle = (chatId: string) => {
    const opening = expanded !== chatId;
    setExpanded(opening ? chatId : null);
    // 关上或换一个群时才按最新设置重新分组，编辑中的群留在原位。
    if (list) setGrouped(overriddenIds(list.groups));
    // 跟随时显示的是「新对话配置」此刻的值：展开时重读一次，上面刚改过也能对上。
    if (opening) {
      const version = requestVersion.current;
      void window.electronAPI.maker
        .imDefaultSettingsGet('feishu')
        .then((defaults) => {
          if (version === requestVersion.current) setChannel(defaults);
        })
        .catch(() => {
          // 读不到就沿用上次的值；保存时 Main 按实时设置解析。
        });
    }
  };

  const groupName = (group: FeishuGroupSettingsView) =>
    group.name ?? t('settings.feishuBot.groups.unnamed', { id: group.chatId.slice(-6) });

  const renderGroup = (group: FeishuGroupSettingsView) => {
    const open = expanded === group.chatId;
    const name = groupName(group);
    return (
      <Fragment key={group.chatId}>
        <SettingsRow
          media
          lead={<GroupAvatar url={group.avatarUrl} />}
          title={name}
          // 跟随的群不重复「跟随渠道设置」（分组标题已经说了），单独设置过的逐项列出。
          hint={hasOverrides(group) ? <GroupSummary group={group} channel={channel} /> : undefined}
          aria-expanded={open}
          aria-label={t('settings.feishuBot.groups.expandAria', { name })}
          onClick={() => toggle(group.chatId)}
          trailing={
            <ChevronDown
              size={14}
              aria-hidden
              className={cn(
                'shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--motion-fast)]',
                open && 'rotate-180',
              )}
            />
          }
        />
        <Collapse open={open}>
          {open && list && channel && (
            <FeishuGroupEditor
              group={group}
              name={name}
              projects={list.projects}
              channel={channel}
              disabled={pending !== null}
              onSave={(patch) => save(group, patch)}
            />
          )}
        </Collapse>
      </Fragment>
    );
  };

  const needle = query.trim().toLocaleLowerCase();
  const searching = needle.length > 0;
  const visible = (list?.groups ?? []).filter(
    (group) => !searching || groupName(group).toLocaleLowerCase().includes(needle),
  );
  const custom = visible.filter((group) => grouped.has(group.chatId));
  const following = visible.filter((group) => !grouped.has(group.chatId));
  const foldable = !searching && following.length > FOLD + 1;
  const shownFollowing = foldable ? following.slice(0, FOLD) : following;
  const hiddenFollowing = foldable ? following.slice(FOLD) : [];
  // 标题旁的群数与收起时的头像：读到完整列表（含之后的保存）以列表为准，之前用概要。
  const headerGroups = list?.groups ?? preview ?? [];
  const customCount = headerGroups.filter(hasOverrides).length;

  return (
    <section {...groupSetting.anchorProps} className="flex flex-col py-1" aria-label={groupSetting.title}>
      {/* 收起时要一眼看出能点开：整行可点（鼠标，带悬停底色），键盘与读屏用右侧的「展开 / 收起」按钮；
          收起时在说明下露出几个群头像。 */}
      <div
        onClick={toggleSection}
        className="-mx-2 flex cursor-pointer select-none items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover-soft)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-lg bg-[var(--settings-input-bg)]">
          <Users size={18} className="text-[var(--settings-section-title)]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 id={titleId} className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
              {groupSetting.title}
            </h3>
            {headerGroups.length > 0 && (
              <span className="text-12 leading-none tabular-nums text-[var(--text-tertiary)]">
                {t('settings.feishuBot.groups.groupCount', { count: headerGroups.length })}
                {customCount > 0 && ` · ${t('settings.feishuBot.groups.customCount', { count: customCount })}`}
              </span>
            )}
          </div>
          <p className="mt-2 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
            {groupSetting.description}
          </p>
          {!sectionOpen && headerGroups.length > 0 && <GroupAvatarStack groups={headerGroups} />}
        </div>
        <div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()}>
          {sectionOpen && (
            <Button
              data-settings-search-action="Refresh the Feishu group list"
              size="sm"
              variant="secondary"
              onClick={() => load(true)}
              disabled={loading}
            >
              <RefreshCw size={14} aria-hidden />
              {t('settings.feishuBot.groups.refresh')}
            </Button>
          )}
          <Button
            data-settings-search-action="Expand or collapse the Feishu group list"
            id={triggerId}
            size="sm"
            variant="secondary"
            aria-expanded={sectionOpen}
            aria-controls={panelId}
            onClick={toggleSection}
          >
            {t(sectionOpen ? 'settings.feishuBot.groups.collapse' : 'settings.feishuBot.groups.expand')}
            <ChevronDown
              size={14}
              aria-hidden
              className={cn(
                'transition-transform duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
                sectionOpen && 'rotate-180',
              )}
            />
          </Button>
        </div>
      </div>

      <Collapse open={sectionOpen} id={panelId} role="region" aria-labelledby={titleId}>
        {sectionOpen && (
          <div className="flex flex-col gap-4 pt-3">
            <p className="text-12 leading-[1.45] text-[var(--text-secondary)]">{t('settings.feishuBot.groups.rules')}</p>
            {loadFailed ? (
              <SettingsNotice tone="error">{t('settings.feishuBot.groups.loadFailed')}</SettingsNotice>
            ) : !list ? (
              <p className="text-12 text-[var(--text-tertiary)]">{t('settings.feishuBot.groups.loading')}</p>
            ) : (
              <>
                {!list.connected && <SettingsNotice>{t('settings.feishuBot.groups.notConnected')}</SettingsNotice>}
                {list.listError && (
                  <SettingsNotice>
                    {t(
                      list.listError === 'permission'
                        ? 'settings.feishuBot.groups.listPermission'
                        : 'settings.feishuBot.groups.listUnavailable',
                    )}
                  </SettingsNotice>
                )}
                {list.groups.length === 0 ? (
                  list.connected && <p className="text-12 text-[var(--text-secondary)]">{t('settings.feishuBot.groups.empty')}</p>
                ) : (
                  <div className="flex flex-col gap-5">
                    {list.groups.length > SEARCH_MIN_GROUPS && (
                      <Input
                        data-settings-search-action="Filter groups in the current list"
                        value={query}
                        onChange={setQuery}
                        type="search"
                        ariaLabel={t('settings.feishuBot.groups.searchLabel')}
                        placeholder={t('settings.feishuBot.groups.searchPlaceholder')}
                      />
                    )}
                    {custom.length > 0 && (
                      <GroupList title={t('settings.feishuBot.groups.customHeading')} count={custom.length}>
                        {custom.map(renderGroup)}
                      </GroupList>
                    )}
                    {following.length > 0 && (
                      <GroupList title={t('settings.feishuBot.groups.followHeading')} count={following.length}>
                        {shownFollowing.map(renderGroup)}
                        {hiddenFollowing.length > 0 && (
                          <>
                            <Collapse open={showAll}>{showAll && hiddenFollowing.map(renderGroup)}</Collapse>
                            <button
                              data-settings-search-action="Show or hide the remaining groups"
                              type="button"
                              aria-expanded={showAll}
                              onClick={() => setShowAll((value) => !value)}
                              className="flex w-full items-center gap-1 border-t border-[var(--settings-theme-card-border)] px-4 py-2.5 text-left text-12 font-medium text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                            >
                              {showAll
                                ? t('settings.feishuBot.groups.showLess')
                                : t('settings.feishuBot.groups.showMore', { count: hiddenFollowing.length })}
                              <ChevronDown
                                size={12}
                                aria-hidden
                                className={cn('transition-transform duration-[var(--motion-fast)]', showAll && 'rotate-180')}
                              />
                            </button>
                          </>
                        )}
                      </GroupList>
                    )}
                    {searching && visible.length === 0 && (
                      <p className="text-12 text-[var(--text-secondary)]">
                        {t('settings.feishuBot.groups.noMatch', { query: query.trim() })}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Collapse>
    </section>
  );
}

/** 一组群：12px 组名加数量，下面一张卡片（同伙伴能力页的分组列表）。 */
function GroupList({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="flex items-baseline gap-1.5 px-1 text-12 font-medium leading-[1.33] text-[var(--text-secondary)]">
        {title}
        <span className="font-normal tabular-nums text-[var(--text-tertiary)]">{count}</span>
      </h4>
      <SettingsCard>{children}</SettingsCard>
    </div>
  );
}

/** 飞书返回的群头像；没有或加载失败时显示群图标。`stacked`：收起时叠放的小头像，带一圈底色描边。 */
function GroupAvatar({ url, stacked = false }: { url: string | null; stacked?: boolean }) {
  const [failed, setFailed] = useState(false);
  const shape = cn(
    'shrink-0 rounded-full bg-[var(--surface-chip)]',
    stacked ? 'h-6 w-6 ring-2 ring-[var(--settings-theme-card-bg)]' : 'h-8 w-8',
  );
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(shape, 'object-cover')}
      />
    );
  }
  return (
    <span className={cn(shape, 'flex items-center justify-center text-[var(--text-secondary)]')}>
      <Users size={stacked ? 12 : 15} aria-hidden />
    </span>
  );
}

/** 收起时的预览：先放有头像的群，最多 6 个，其余写成 +N。 */
const STACK_LIMIT = 6;
function GroupAvatarStack({ groups }: { groups: readonly FeishuGroupSettingsView[] }) {
  const ordered = [...groups].sort((a, b) => Number(!a.avatarUrl) - Number(!b.avatarUrl));
  const shown = ordered.slice(0, STACK_LIMIT);
  const rest = groups.length - shown.length;
  return (
    <div className="mt-2.5 flex items-center" aria-hidden>
      <div className="flex -space-x-1.5">
        {shown.map((group) => (
          <GroupAvatar key={group.chatId} url={group.avatarUrl} stacked />
        ))}
      </div>
      {rest > 0 && <span className="ml-2 text-12 tabular-nums text-[var(--text-tertiary)]">+{rest}</span>}
    </div>
  );
}

/** 单独设置过的群在名字下逐项列出：项目名、模型、权限档。 */
function GroupSummary({ group, channel }: { group: FeishuGroupSettingsView; channel: ImDefaultSettingsState | null }) {
  const { t, i18n } = useTranslation();
  const agentKind = group.route?.agentKind ?? channel?.agentKind ?? 'claude-code';
  const permissionKey = group.permissionMode
    ? `newChat.permissionSelector.modes.${agentKind}.${group.permissionMode}.label`
    : null;
  return (
    <span className="flex flex-wrap gap-1">
      {group.project && (
        <Chip icon={<FolderOpen size={11} aria-hidden />}>
          {group.project.available
            ? group.project.name
            : t('settings.feishuBot.groups.project.missing', { name: group.project.name })}
        </Chip>
      )}
      {group.route && (
        <Chip icon={<Sparkles size={11} aria-hidden />}>{t('settings.feishuBot.groups.summaryModel')}</Chip>
      )}
      {permissionKey && (
        <Chip icon={<ShieldCheck size={11} aria-hidden />}>
          {i18n.exists(permissionKey) ? t(permissionKey) : t('settings.feishuBot.groups.summaryPermission')}
        </Chip>
      )}
    </span>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-[1.45] text-[var(--text-secondary)]">
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function EditorField({
  label,
  hint,
  customized,
  disabled,
  onReset,
  children,
}: {
  label: string;
  hint: string;
  customized: boolean;
  disabled: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <span className="text-12 font-medium text-[var(--text-secondary)]">{label}</span>
        <DefaultOverrideControls isCustomized={customized} disabled={disabled} onReset={onReset} />
      </div>
      {children}
      <p className="text-11 leading-[1.45] text-[var(--text-secondary)]">{hint}</p>
    </div>
  );
}

function FeishuGroupEditor({
  group,
  name,
  projects,
  channel,
  disabled,
  onSave,
}: {
  group: FeishuGroupSettingsView;
  name: string;
  projects: FeishuGroupSettingsList['projects'];
  channel: ImDefaultSettingsState;
  disabled: boolean;
  onSave: (patch: FeishuGroupSettingsPatch) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const groupSetting = useSettingDefinition(imBotSettings.feishuGroups);
  const { confirm } = useConfirmDialog();
  // 跟随时显示并在此基础上修改的是渠道此刻的路由；改了任何一项就整条存成这个群的路由。
  // 跟随的来源：群绑定了项目、且「项目与模型」里对得上那一行时跟随项目，否则跟随渠道设置。
  const followedProject =
    group.project?.available && group.project.config ? { name: group.project.name, ...group.project.config } : null;
  const inheritedRoute = followedProject
    ? followedProject.route ?? { ...channelRoute(channel), model: '' }
    : channelRoute(channel);
  const route = group.route ?? inheritedRoute;
  const customizedRoute = group.route !== null;
  const agentDeviceId = route.agentDeviceId;
  const routeDevices = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: agentDeviceId });
  const pickerAgents = useModelPickerAgents(route.agentKind, agentDeviceId);
  const { config: modelGroupsConfig } = useModelGroups();
  const lastUnifiedRouteRef = useRef<FeishuGroupRoute | null>(null);

  const projectOptions: SelectOption[] = [
    { value: FOLLOW, label: t('settings.feishuBot.groups.project.follow') },
    ...(group.project && !group.project.available
      ? [{ value: MISSING, label: t('settings.feishuBot.groups.project.missing', { name: group.project.name }), disabled: true }]
      : []),
    ...projects.map((project) => ({ value: project.token, label: project.name })),
  ];
  const projectValue = group.project ? (group.project.available ? group.project.token : MISSING) : FOLLOW;

  // 渠道是「自动选择」却暂时没有可用模型时，继承来的模型是空的，不能拿它存成群设置。
  const saveRoute = (next: FeishuGroupRoute) => (next.model.trim() ? onSave({ route: next }) : false);
  const selectGroupModelGroup = async (selection: ModelGroupSelection) => {
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
      model: preview.route.model,
      providerId: preview.route.providerId,
      agentDeviceId: preview.route.agentDeviceId ?? null,
      effort: isImDefaultEffort(preview.route.effort) ? preview.route.effort : route.effort,
      modelGroup: selection.id,
    });
  };

  const inheritedPermission = followedProject?.permissionMode ?? channel.groupPermissionMode;
  const effectivePermission = group.permissionMode ?? inheritedPermission;
  const permissionLabel = (mode: string) => {
    const key = `newChat.permissionSelector.modes.${route.agentKind}.${mode}.label`;
    return i18n.exists(key) ? t(key) : mode;
  };
  const confirmWiderPermission = (next: ImDefaultPermissionMode) =>
    !isWiderPermissionMode(next, effectivePermission) ||
    confirm({
      title: t('settings.feishuBot.groups.widerConfirm.title', { name }),
      description: t('settings.feishuBot.groups.widerConfirm.description', {
        current: permissionLabel(effectivePermission),
        next: permissionLabel(next),
      }),
      confirmText: t('settings.feishuBot.groups.widerConfirm.confirm'),
      cancelText: t('settings.feishuBot.groups.widerConfirm.cancel'),
      confirmVariant: 'destructive',
    });

  const changeProject = async (value: string) => {
    if (value === MISSING || value === projectValue) return;
    const token = value === FOLLOW ? null : value;
    const next =
      group.permissionMode ??
      projects.find((project) => project.token === token)?.permissionMode ??
      channel.groupPermissionMode;
    if (await confirmWiderPermission(next)) await onSave({ projectToken: token });
  };
  const resetPermission = async () => {
    if (await confirmWiderPermission(inheritedPermission)) await onSave({ permissionMode: null });
  };
  const changePermission = async (mode: string) => {
    if (!isImDefaultPermissionMode(mode)) return;
    if (mode === group.permissionMode) return;
    if (mode === 'bypassPermissions') {
      const confirmed = await confirm({
        title: t('settings.feishuBot.groups.fullAccessConfirm.title', { name }),
        description: t('settings.feishuBot.groups.fullAccessConfirm.description'),
        confirmText: t('settings.feishuBot.groups.fullAccessConfirm.confirm'),
        cancelText: t('settings.feishuBot.groups.fullAccessConfirm.cancel'),
        confirmVariant: 'destructive',
      });
      if (!confirmed) return;
    }
    await onSave({ permissionMode: mode as ImDefaultPermissionMode });
  };

  return (
    <div
      data-feishu-group-editor={group.chatId}
      className="flex flex-col gap-5 border-t border-[var(--settings-theme-card-border)] py-4 pl-[60px] pr-4"
    >
      <EditorField
        label={t('settings.feishuBot.groups.project.label')}
        hint={t('settings.feishuBot.groups.project.hint')}
        customized={group.project !== null}
        disabled={disabled}
        onReset={() => void changeProject(FOLLOW)}
      >
        <Select
          {...groupSetting.controlProps}
          label={t('settings.feishuBot.groups.project.label')}
          value={projectValue}
          options={projectOptions}
          width="full"
          disabled={disabled}
          onValueChange={(value) => void changeProject(value)}
        />
      </EditorField>
      <EditorField
        label={t('settings.feishuBot.groups.model.label')}
        hint={
          customizedRoute
            ? t('settings.feishuBot.groups.model.hintFixed')
            : followedProject
              ? t(
                  followedProject.route
                    ? 'settings.feishuBot.groups.model.hintFollowProject'
                    : 'settings.feishuBot.groups.model.hintProjectUnavailable',
                  { project: followedProject.name },
                )
              : t('settings.feishuBot.groups.model.hintFollow')
        }
        customized={customizedRoute}
        disabled={disabled}
        onReset={() => void onSave({ route: null })}
      >
        <ModelSelector
          remoteAgent={routeDevices.devices && { devices: routeDevices.devices, selectedDeviceId: agentDeviceId }}
          deviceId={agentDeviceId ?? undefined}
          agentDevice={
            agentDeviceId
              ? {
                  deviceId: agentDeviceId,
                  name: routeDevices.devices?.find((device) => device.deviceId === agentDeviceId)?.name ?? null,
                }
              : null
          }
          fastModeConfigurable={false}
          unifiedAgents={pickerAgents}
          // 跟随时显示的是继承来的模型；点它也要落成这个群的设置（同 IM 工作区偏好）。
          reselectEmitsChange
          modelGroups={{
            config: modelGroupsConfig,
            active: route.modelGroup && modelGroupsConfig.routes.some((r) => r.id === route.modelGroup)
              ? { type: 'route', id: route.modelGroup }
              : null,
            onSelect: (selection) => { void selectGroupModelGroup(selection); },
            onAttach: (selection) => {
              const last = lastUnifiedRouteRef.current;
              lastUnifiedRouteRef.current = null;
              if (last) void saveRoute({ ...last, modelGroup: selection.id });
            },
            onManage: () => { window.location.hash = '#/settings?tab=model-groups'; },
          }}
          onUnifiedSelect={({ engine, modelId, providerId, effort, agentDevice }) => {
            const next: FeishuGroupRoute = {
              agentKind: agentKindOfVendor(engine),
              model: modelId,
              providerId,
              agentDeviceId: agentDevice?.deviceId ?? null,
              effort: isImDefaultEffort(effort) ? effort : route.effort,
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
          currentProviderId={route.providerId}
          switching={disabled}
          triggerVariant="field"
          popoverSide="bottom"
          ariaContext={`${t('settings.feishuBot.groups.model.label')} · ${name}`}
        />
      </EditorField>
      <EditorField
        label={t('settings.feishuBot.groups.permission.label')}
        hint={
          group.permissionMode
            ? t('settings.feishuBot.groups.permission.hintFixed')
            : followedProject?.permissionMode
              ? t('settings.feishuBot.groups.permission.hintFollowProject', { project: followedProject.name })
              : t('settings.feishuBot.groups.permission.hintFollow')
        }
        customized={group.permissionMode !== null}
        disabled={disabled}
        onReset={() => void resetPermission()}
      >
        <PermissionSelector
          permissionMode={effectivePermission}
          vendorKey={vendorKeyFor(route.agentKind)}
          triggerVariant="field"
          disabled={disabled}
          ariaContext={`${t('settings.feishuBot.groups.permission.label')} · ${name}`}
          onPermissionModeChange={(mode) => void changePermission(mode)}
        />
      </EditorField>
    </div>
  );
}
