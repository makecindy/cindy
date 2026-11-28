import { imBotSettings } from './ImBotSection.settings-search';
/**
 * ImBotSection —— 「IM 机器人」设置页: 一个聊天软件一行, 点进去设置(2026-11-24 用户选定方案 A)。
 *
 *   - 主页: 「已连接」与「还可以连接」两组, 每个聊天软件只出现一次; 行内一句话说清状态和谁来回复。
 *     底部是声明了 IM 入口的插件。
 *   - 聊天软件子页: 同时有官方机器人与你自己的机器人时两种方式上下排列(官方一张卡, 自己的一组卡);
 *     只有一种方式时直接给那一种。最常改的(谁来回复、模型、群聊)在上, 不常改的收进下一层页面,
 *     连接与解绑在最下面。
 *   - 导航是页面内状态(主页 → 子页 → 更深一层), 返回逐级退回; 设置搜索的结果先打开对应子页,
 *     再由 useSettingsSectionTarget 定位到具体一项。
 *
 * 官方机器人整组只挂一份 HookConnectionsSection(固定在同一位置, 换页不重挂): 主页用它回报的状态画行,
 * 子页只显示对应那一张卡, 自动弹出的确认框也只有一份。本地模式没有官方机器人。
 */

import {
  AtSign,
  Briefcase,
  Feather,
  Gamepad2,
  Hash,
  MessageCircle,
  Send,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { useBotProfiles } from '@/features/bots/botStore';
import type { BotImConnectionView } from '../../../shared/botImConnection';
import {
  SettingsCard,
  SettingsPageHeader,
  SettingsPageScope,
  SettingsRow,
  SettingsRowIcon,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { useSettingsSubpageBack } from './useSettingsEscape';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';
import { DingTalkBotSettings, useDingTalkListStatus } from './DingTalkBotSection';
import { DiscordBotSettings, useDiscordListStatus } from './DiscordBotSection';
import { FeishuBotSettings, useFeishuListStatus } from './FeishuBotSection';
import {
  HookConnectionsSection,
  type CindyImCard,
  type ChannelBadgeTone,
  type HookConnectionsShow,
  type OfficialImSummary,
} from './HookConnectionsSection';
import { ImBotNavProvider, ImBotStatusText, type ImBotNav, type ImBotStatusTone } from './ImBotPageParts';
import { ImPluginEntrancesCard, useImEntrancePlugins } from './ImPluginEntrances';
import { useImReplyTarget } from './ImReplyTargetField';
import { TelegramBotSettings, useTelegramListStatus } from './TelegramBotSection';
import { WechatBotSettings, useWechatListStatus } from './WechatBotSection';
import { WecomBotSettings, useWecomListStatus } from './WecomBotSection';
import { showCindyGroup } from './imBotVisibility';

/** 「IM 机器人」旧分区 id(?imGroup= 深链与设置跳转仍会带它); 新结构下都落在主页。 */
export type ImBotSettingsGroup = 'cindy' | 'personal';

export function isImBotSettingsGroup(value: string | null): value is ImBotSettingsGroup {
  return value === 'cindy' || value === 'personal';
}

type ImBotApp = 'wechat' | 'feishu' | 'telegram' | 'slack' | 'discord' | 'wecom' | 'dingtalk' | 'x';
type PersonalApp = Exclude<ImBotApp, 'slack' | 'x'>;

interface AppDef {
  id: ImBotApp;
  icon: LucideIcon;
  /** 官方机器人渠道(没有 = 只有你自己的机器人)。 */
  official?: CindyImCard;
  /** 有「你自己的机器人」这种方式。 */
  personal: boolean;
}

/** 主页顺序: 国内常用在前, 海外在后; 同组内按常用程度。 */
const APPS: readonly AppDef[] = [
  { id: 'wechat', icon: MessageCircle, personal: true },
  { id: 'feishu', icon: Feather, official: 'feishu', personal: true },
  { id: 'wecom', icon: Briefcase, personal: true },
  { id: 'dingtalk', icon: Zap, personal: true },
  { id: 'telegram', icon: Send, official: 'telegram', personal: true },
  { id: 'slack', icon: Hash, official: 'slack', personal: false },
  { id: 'discord', icon: Gamepad2, official: 'discord', personal: true },
  { id: 'x', icon: AtSign, official: 'x', personal: false },
];

type Nav =
  | { app: ImBotApp; page: string | null }
  | { app: 'projects'; page: null; returnApp?: ImBotApp }
  | null;

/** 设置搜索 / 深链的落点 → 该打开哪个子页(以及更深一层)。 */
function navForTarget(targetId: string | undefined): Nav {
  if (!targetId) return null;
  if (targetId === imBotSettings.projects.targetId) return { app: 'projects', page: null };
  if (targetId === 'personal-im-feishu-groups') return { app: 'feishu', page: null };
  if (targetId === 'personal-im-discord-channels') return { app: 'discord', page: 'channels' };
  if (targetId === 'cindy-im-feishu-working-device') return { app: 'feishu', page: null };
  const match = /^(?:cindy|personal)-im-([a-z]+)$/.exec(targetId);
  const app = match?.[1] as ImBotApp | undefined;
  return app && APPS.some((item) => item.id === app) ? { app, page: null } : null;
}

const OFFICIAL_TONE: Record<ChannelBadgeTone, ImBotStatusTone> = {
  ok: 'connected',
  progress: 'progress',
  attention: 'attention',
  error: 'error',
};

function AppIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <SettingsRowIcon><Icon size={16} aria-hidden /></SettingsRowIcon>;
}

export function ImBotSection({ targetGroup: _targetGroup }: { targetGroup: ImBotSettingsGroup | null }) {
  const { mode, dataOwnerId } = useAuth();
  // 换账号时整页从主页重新开始(各渠道状态都按数据主人缓存)。
  return <ImBotPages key={`${mode}:${dataOwnerId ?? 'none'}`} cindyGroupAvailable={showCindyGroup({ mode })} />;
}

function ImBotPages({ cindyGroupAvailable }: { cindyGroupAvailable: boolean }) {
  const { t } = useTranslation();
  const { entry, activation } = useSettingsSearchNavigation();
  const imPlugins = useImEntrancePlugins();
  const bots = useBotProfiles();
  const [official, setOfficial] = useState<OfficialImSummary>({});
  const [companionConnections, setCompanionConnections] = useState<BotImConnectionView[]>([]);
  const [nav, setNav] = useState<Nav>(() => navForTarget(entry?.targetId) ?? navForTarget(entry?.fallbackTargetId));
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 订阅本机已在「伙伴 → 消息平台」里配置的伙伴专属机器人，升级后设置页主页与子页都能一眼看见。
  useEffect(() => {
    const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.botImConnection;
    if (!api || typeof api.list !== 'function') return;
    let cancelled = false;
    void api.list()
      .then((payload) => { if (!cancelled) setCompanionConnections(payload.connections ?? []); })
      .catch(() => {});
    const off = api.onChanged?.((payload) => {
      if (!cancelled) setCompanionConnections(payload.connections ?? []);
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  // 各渠道状态(只读订阅, 与子页同一份 hook)。
  const personal: Record<PersonalApp, { configured: boolean; tone: ImBotStatusTone; labelKey: string }> = {
    wechat: useWechatListStatus(),
    feishu: useFeishuListStatus(),
    telegram: useTelegramListStatus(),
    discord: useDiscordListStatus(),
    wecom: useWecomListStatus(),
    dingtalk: useDingTalkListStatus(),
  };
  const replyTargets = {
    telegram: useImReplyTarget('telegram'),
    feishu: useImReplyTarget('feishu'),
    discord: useImReplyTarget('discord'),
    wecom: useImReplyTarget('wecom'),
    dingtalk: useImReplyTarget('dingtalk'),
  };
  const wechatCompanion = useWechatListStatus().companionBotId;

  /** 官方渠道在这个账号 / 这次灰度里是否出现。 */
  const officialVisible = useCallback(
    (app: AppDef) => cindyGroupAvailable && !!app.official && official[app.official]?.visible === true,
    [cindyGroupAvailable, official],
  );
  const availableApps = APPS.filter((app) => app.personal || officialVisible(app));

  // 搜索结果 / 深链: 打开对应子页(官方渠道还没下发时留在主页)。
  useLayoutEffect(() => {
    const target = navForTarget(entry?.targetId) ?? navForTarget(entry?.fallbackTargetId);
    if (!target) return;
    setNav(target);
  }, [entry, activation]);

  // 换页回到顶部(搜索定位在这之后接管滚动)。
  const navKey = nav ? `${nav.app}/${nav.page ?? ''}` : '';
  useLayoutEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'start' });
  }, [navKey]);

  const openApp = (app: ImBotApp | 'projects') =>
    setNav(app === 'projects' ? { app: 'projects', page: null } : { app, page: null });
  const appName = useCallback((id: ImBotApp) => t(`settings.imBot.apps.${id}`), [t]);
  const stepBack = useCallback(() => {
    setNav((current) => {
      if (!current) return null;
      if (current.app === 'projects') {
        return current.returnApp ? { app: current.returnApp, page: null } : null;
      }
      return current.page ? { ...current, page: null } : null;
    });
  }, []);
  useSettingsSubpageBack(nav ? stepBack : null);

  const appNav: ImBotNav = useMemo(() => {
    const def = nav && nav.app !== 'projects' ? APPS.find((app) => app.id === nav.app) : undefined;
    return {
      page: nav?.page ?? null,
      open: (page) => setNav((current) => (current && current.app !== 'projects' ? { ...current, page } : current)),
      openProjects: () => setNav((current) => ({
        app: 'projects',
        page: null,
        ...(current && current.app !== 'projects' ? { returnApp: current.app } : {}),
      })),
      back: stepBack,
      appName: def ? appName(def.id) : undefined,
      multiWay: !!def && def.personal && officialVisible(def),
      companionConnections,
    };
  }, [nav, officialVisible, stepBack, appName, companionConnections]);

  const companionName = (id: string | null | undefined) =>
    id ? bots.find((bot) => bot.id === id)?.name ?? t('settings.imBot.replyTarget.missingCompanion') : null;

  /** 主页一行的状态与说明。 */
  const rowFor = (app: AppDef): { inUse: boolean; hint: ReactNode } => {
    const parts: string[] = [];
    let tone: ImBotStatusTone = 'off';
    const mine = app.personal ? personal[app.id as PersonalApp] : null;
    if (mine?.configured) {
      tone = mine.tone;
      parts.push(t(mine.labelKey));
      if (mine.tone === 'connected') {
        const companionId = app.id === 'wechat'
          ? wechatCompanion
          : replyTargets[app.id as keyof typeof replyTargets]?.companionBotId;
        const name = companionName(companionId);
        parts.push(name ? t('settings.imBot.replyTarget.summary', { name }) : t('settings.imBot.list.cindyReplies'));
      }
    }
    const theirs = app.official && officialVisible(app) ? official[app.official] : undefined;
    if (theirs?.enabled) {
      if (!mine?.configured) tone = OFFICIAL_TONE[theirs.tone];
      parts.push(app.personal ? t('settings.imBot.list.official', { status: theirs.label }) : theirs.label);
      const name = companionName(theirs.companionBotId);
      if (name) parts.push(t('settings.imBot.replyTarget.summary', { name }));
    }
    const dedicated = companionConnections.filter((conn) => conn.channel === app.id);
    if (dedicated.length > 0) {
      const anyConnected = dedicated.some((conn) => conn.status.kind === 'connected');
      const anyError = dedicated.some((conn) => conn.status.kind === 'error');
      const anyProgress = dedicated.some((conn) => conn.status.kind === 'connecting' || conn.status.kind === 'conflict');
      if (parts.length === 0) {
        tone = anyConnected ? 'connected' : anyError ? 'error' : anyProgress ? 'progress' : 'off';
      }
      const names = [...new Set(dedicated.map((conn) => companionName(conn.botId)).filter((n): n is string => Boolean(n)))];
      parts.push(t('settings.imBot.list.companionDedicated', {
        names: names.join(t('bots.channels.handedOverSeparator')),
      }));
    }
    if (parts.length > 0) return { inUse: true, hint: <ImBotStatusText tone={tone}>{parts.join(' · ')}</ImBotStatusText> };
    const hintKey = app.id === 'slack' || app.id === 'x' || app.id === 'wechat'
      ? `settings.imBot.list.hint.${app.id}`
      : officialVisible(app) ? 'settings.imBot.list.hint.both' : 'settings.imBot.list.hint.personal';
    return { inUse: false, hint: t(hintKey) };
  };

  const rootTitle = t(imBotSettings.imBot.sectionKey);

  let content: ReactNode = null;
  let officialShow: HookConnectionsShow = 'list';
  let personalPart: ReactNode = null;

  if (nav === null) {
    const rows = availableApps.map((app) => ({ app, ...rowFor(app) }));
    const inUse = rows.filter((row) => row.inUse);
    const rest = rows.filter((row) => !row.inUse);
    const renderRows = (items: typeof rows) => (
      <SettingsCard>
        {items.map(({ app, hint }) => (
          <SettingsRow key={app.id} lead={<AppIcon icon={app.icon} />} title={appName(app.id)} hint={hint}
            chevron onClick={() => openApp(app.id)} data-im-bot-app={app.id} />
        ))}
      </SettingsCard>
    );
    content = (
      <div id="im-bot-apps" className="flex min-w-0 flex-col">
        <SettingsPageHeader
          title={rootTitle}
          description={t(imBotSettings.imBot.descriptionKey)}
          adornment={<span className="rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-px text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
            {t('settings.imBot.beta')}
          </span>}
        />
        <div className="mt-6 flex min-w-0 flex-col gap-9">
          {inUse.length > 0 ? <SettingsSection title={t('settings.imBot.list.connected')}>{renderRows(inUse)}</SettingsSection> : null}
          {rest.length > 0 ? (
            <SettingsSection title={t(inUse.length > 0 ? 'settings.imBot.list.available' : 'settings.imBot.list.choose')}>
              {renderRows(rest)}
            </SettingsSection>
          ) : null}
          {/* 「项目与模型」独立成组，方便查找；官方机器人、选了项目的个人机器人和插件共用这一份。 */}
          <SettingsSection className="scroll-mt-4" title={t('settings.imBot.groups.shared')}>
            <SettingsCard>
              <SettingsRow title={t(imBotSettings.projects.titleKey)} hint={t(imBotSettings.projects.descriptionKey)}
                chevron onClick={() => openApp('projects')} />
            </SettingsCard>
          </SettingsSection>
          {imPlugins.length > 0 ? (
            <SettingsSection id="im-bot-group-plugins" className="scroll-mt-4"
              title={t('settings.imBot.groups.plugins')}
              description={t('settings.imBot.tips.plugins')}>
              <ImPluginEntrancesCard plugins={imPlugins} />
            </SettingsSection>
          ) : null}
        </div>
      </div>
    );
  } else if (nav.app === 'projects') {
    officialShow = 'projects';
    const backTarget = nav.returnApp ? appName(nav.returnApp) : rootTitle;
    const backLabel = t('settings.imBot.nav.backTo', { page: backTarget });
    content = (
      <SettingsPageHeader titleId={imBotSettings.projects.targetId} title={t(imBotSettings.projects.titleKey)} description={t(imBotSettings.projects.descriptionKey)}
        onBack={appNav.back} backLabel={backLabel} backProps={{ title: backLabel }} />
    );
  } else {
    const def = APPS.find((app) => app.id === nav.app)!;
    if (!nav.page) {
      const backLabel = t('settings.imBot.nav.backTo', { page: rootTitle });
      content = (
        <SettingsPageHeader title={appName(def.id)} onBack={appNav.back} backLabel={backLabel} backProps={{ title: backLabel }} />
      );
      if (def.official && officialVisible(def)) officialShow = def.official;
    }
    if (def.personal) {
      personalPart = def.id === 'wechat' ? <WechatBotSettings />
        : def.id === 'feishu' ? <FeishuBotSettings
            preferredService={entry?.id === 'imBot.lark' ? 'lark' : entry?.id === 'imBot.feishu' ? 'feishu' : null}
            searchActivation={activation} />
          : def.id === 'telegram' ? <TelegramBotSettings />
            : def.id === 'discord' ? <DiscordBotSettings />
              : def.id === 'wecom' ? <WecomBotSettings />
                : <DingTalkBotSettings />;
    }
  }

  const appHeaderShown = !!nav && !(nav.app !== 'projects' && nav.page);
  // 官方机器人那张卡与「用你自己的机器人」一行入口平级时(还没配好自己的), 两张卡贴近成一组(14px)。
  const pairedCards = !!nav && nav.app !== 'projects' && appNav.multiWay
    && !personal[nav.app as PersonalApp]?.configured;

  return (
    <ImBotNavProvider value={appNav}>
      <SettingsPageScope>
        {/* 三个位置固定(页头 / 官方机器人 / 你自己的机器人): 官方那一份换页时不重挂。标题到内容 24px, 两组之间 36px。 */}
        <div ref={rootRef} className={cn('flex min-w-0 flex-col', appHeaderShown && (pairedCards
          ? 'gap-3.5 [&>*:first-child]:mb-2.5'
          : 'gap-9 [&>*:first-child]:-mb-3'))}>
          {content}
          {cindyGroupAvailable || officialShow === 'projects' ? (
            <HookConnectionsSection show={officialShow} onSummary={cindyGroupAvailable ? setOfficial : undefined} />
          ) : null}
          {personalPart}
        </div>
      </SettingsPageScope>
    </ImBotNavProvider>
  );
}
