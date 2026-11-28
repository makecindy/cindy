/**
 * 「IM 机器人」页的共用零件(主页列表 → 聊天软件子页 → 更深一层的设置页)。
 *
 * 导航是页面内状态(ImBotSection 持有): 子页与更深一层都在同一个设置 tab 里换内容,
 * 返回按钮逐级退回。各渠道组件经 useImBotNav 打开自己的更深一层页面, 不直接改 URL。
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  SettingsBlock,
  SettingsCard,
  SettingsPageHeader,
  SettingsPageScope,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { useBotProfiles } from '@/features/bots/botStore';
import { maskBotImContextId } from '@/features/bots/botImConnectionClient';
import { pluginEngineModelName } from '@/lib/pluginEngineSelection';
import type { BotImChannel, BotImConnectionView } from '../../../shared/botImConnection';
import type { ImDefaultSettingsChannel } from '../../../shared/imDefaultSettings';
import { PLUGIN_ENGINE_DEFAULT_MODEL } from '../../../shared/pluginEngines';
import { useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { useSettingsPluginEngines } from './useSettingsPluginEngines';

export interface ImBotNav {
  /** 当前打开的更深一层页面; null = 聊天软件子页本身。 */
  page: string | null;
  open(page: string): void;
  /** 从当前子页跳转到「项目与模型」，点返回时回到当前子页。 */
  openProjects(): void;
  back(): void;
  /** 当前所在聊天软件的名称(供更深一层页面的返回按钮标注上一级)。 */
  appName?: string;
  /** 这个聊天软件同时有官方机器人与自己的机器人两种方式(决定自己的机器人是否单独成组)。 */
  multiWay: boolean;
  /** 本机已在「伙伴 → 消息平台」配置的伙伴专属机器人(只读展示，升级不丢设置)。 */
  companionConnections: readonly BotImConnectionView[];
}

const ImBotNavContext = createContext<ImBotNav>({
  page: null,
  open: () => {},
  openProjects: () => {},
  back: () => {},
  multiWay: false,
  companionConnections: [],
});

export const ImBotNavProvider = ImBotNavContext.Provider;

export function useImBotNav(): ImBotNav {
  return useContext(ImBotNavContext);
}

/** 更深一层的设置页: 返回到聊天软件子页, 标题下 24px 开始内容。 */
export function ImBotSubPage({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  const nav = useImBotNav();
  const backLabel = nav.appName
    ? t('settings.imBot.nav.backTo', { page: nav.appName })
    : t('settings.imBot.nav.back');
  return (
    <SettingsPageScope>
      <section className="flex min-w-0 flex-col">
        <SettingsPageHeader
          title={title}
          description={description}
          onBack={nav.back}
          backLabel={backLabel}
          backProps={{ title: backLabel }}
        />
        <div className="mt-6 flex min-w-0 flex-col gap-9">{children}</div>
      </section>
    </SettingsPageScope>
  );
}

export type ImBotStatusTone = 'connected' | 'progress' | 'attention' | 'error' | 'off';

const DOT_COLOR: Record<ImBotStatusTone, string> = {
  connected: 'var(--settings-badge-connected)',
  progress: 'var(--settings-badge-saved)',
  attention: 'var(--settings-badge-saved)',
  error: 'var(--settings-badge-error)',
  off: 'var(--settings-badge-needs-config)',
};

/** 行内状态: 小圆点 + 一句话(颜色只在点上, 文字保持次级色便于阅读)。 */
export function ImBotStatusText({ tone, children }: { tone: ImBotStatusTone; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: DOT_COLOR[tone] }} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}

/** 「怎么创建机器人」: 默认收起的步骤说明 + 外链。 */
export function ImBotSetupGuide({ title, steps, linkLabel, onOpenLink, settingId }: {
  title: string;
  steps: Array<{ title?: string; body: string }>;
  linkLabel?: string;
  onOpenLink?: () => void;
  settingId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--settings-theme-card-border)] pt-3">
      <button data-setting-id={settingId} type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 bg-transparent p-0 text-left">
        <span className="text-13 font-medium text-[var(--settings-section-title)]">{title}</span>
        <span className="text-[var(--settings-section-desc)]">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          {steps.map((step, index) => (
            <div key={index} className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-11 font-medium text-[var(--settings-section-title)]">
                {index + 1}
              </span>
              <div className="min-w-0">
                {step.title ? <div className="text-12 font-medium text-[var(--settings-section-title)]">{step.title}</div> : null}
                <div className="mt-0.5 text-12 leading-[1.6] text-[var(--settings-section-desc)]">{step.body}</div>
              </div>
            </div>
          ))}
          {linkLabel && onOpenLink ? (
            <button data-setting-id={settingId} type="button" onClick={onOpenLink}
              className="w-fit cursor-pointer bg-transparent p-0 text-12 font-medium text-[var(--settings-source-link)] underline decoration-[var(--settings-source-link)] decoration-1 underline-offset-2">
              {linkLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「你自己的机器人」这一组。聊天软件同时有官方机器人时才带组名; 只有一种方式时内容直接放在子页里。
 * id 是设置搜索的落点(personal-im-<channel>)。
 */
export function ImBotPersonalWay({ id, configured = true, children }: { id: string; configured?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const nav = useImBotNav();
  // 还没配好时只有一行「用你自己的机器人」, 与官方机器人那张卡平级, 不加组名。
  const titled = nav.multiWay && configured;
  return (
    <SettingsSection id={id} className="scroll-mt-4"
      title={titled ? t('settings.imBot.ways.personal') : undefined}
      description={titled ? t('settings.imBot.ways.personalHint') : undefined}>
      {children}
    </SettingsSection>
  );
}

/** 还没配好自己的机器人、且这个聊天软件也有官方机器人时: 一行入口, 点「设置」进填写页。 */
export function ImBotSetupRow({ hint, status, settingId }: { hint: string; status?: ReactNode; settingId?: string }) {
  const { t } = useTranslation();
  const nav = useImBotNav();
  return (
    <SettingsCard>
      <SettingsRow wrap title={t('settings.imBot.ways.personalSetupTitle')} hint={status ?? hint}
        trailing={<Button data-setting-id={settingId} variant="secondary" size="sm" onClick={() => nav.open('setup')}>
          {t('settings.imBot.ways.setUp')}
        </Button>} />
    </SettingsCard>
  );
}

/** 宽内容(表单、选择器、原有设置块)放进一张卡里, 保持与设置行同样的内边距。 */
export function ImBotBlockCard({ children }: { children: ReactNode }) {
  return (
    <SettingsCard>
      <SettingsBlock className="flex flex-col gap-5">{children}</SettingsBlock>
    </SettingsCard>
  );
}

/** 「模型」行: 显示当前 Agent · 模型, 点进去是完整的模型设置。 */
export function ImBotModelRow({ channel, settingId }: { channel: ImDefaultSettingsChannel; settingId?: string }) {
  const { t } = useTranslation();
  const nav = useImBotNav();
  const [summary] = useImChannelSettingsSummary(channel);
  const isPluginEngine = summary?.agentKind === 'acp';
  const pluginEngines = useSettingsPluginEngines(isPluginEngine ? (summary.agentDeviceId ?? null) : null);
  const matchedEngine = isPluginEngine && summary?.providerId
    ? pluginEngines.engines.find(
        (engine) =>
          engine.providerId === summary.providerId &&
          (engine.deviceId ?? null) === (summary.agentDeviceId ?? null),
      ) ?? null
    : null;
  const agentLabel = summary
    ? isPluginEngine
      ? matchedEngine?.name ?? t('newChat.pluginEngines.genericName')
      : t(`settings.imBot.defaults.agents.${summary.agentKind}`)
    : null;
  const modelLabel = summary
    ? isPluginEngine && summary.model === PLUGIN_ENGINE_DEFAULT_MODEL
      ? t('newChat.pluginEngines.defaultModel')
      : isPluginEngine
        ? pluginEngineModelName(matchedEngine, summary.model) ?? summary.model
        : summary.model
    : null;
  return (
    <SettingsRow
      data-setting-id={settingId}
      title={t('settings.imBot.rows.model')}
      // Agent 与模型各自不断行: 窄窗口里只在「·」处换行, 不把模型名拦腰截断。
      value={summary && agentLabel && modelLabel ? <>
        <span className="whitespace-nowrap">{agentLabel} ·</span>{' '}
        <span className="whitespace-nowrap">{modelLabel}</span>
      </> : undefined}
      chevron
      onClick={() => nav.open('model')}
    />
  );
}

/** 选了项目(或官方机器人使用「项目与模型」)时的「模型与权限」直达行，避免隐藏后找不到修改入口。 */
export function ImProjectModelLinkRow({
  summary,
  settingId,
}: {
  summary?: ReactNode;
  settingId?: string;
}) {
  const { t } = useTranslation();
  const nav = useImBotNav();
  return (
    <SettingsRow
      data-setting-id={settingId}
      title={t('settings.imBot.rows.projectModel')}
      hint={t('settings.imBot.rows.projectModelHint')}
      value={summary}
      chevron
      onClick={() => nav.openProjects()}
    />
  );
}

const COMPANION_CONN_TONE: Record<BotImConnectionView['status']['kind'], ImBotStatusTone> = {
  connected: 'connected',
  connecting: 'progress',
  conflict: 'attention',
  offline: 'off',
  idle: 'off',
  error: 'error',
};

/** 平台子页底部: 只读展示在「伙伴 → 消息平台」里单独配置的伙伴专属机器人，一键跳去管理。没有时不渲染。 */
export function ImCompanionBotsSection({ channel }: { channel: Exclude<BotImChannel, 'imessage'> }) {
  const nav = useImBotNav();
  const inRouter = useInRouterContext();
  const connections = nav.companionConnections.filter((item) => item.channel === channel);
  if (connections.length === 0) return null;
  return inRouter
    ? <ImCompanionBotsSectionWithNav channel={channel} connections={connections} />
    : <ImCompanionBotsSectionBody channel={channel} connections={connections} />;
}

function ImCompanionBotsSectionWithNav({
  channel,
  connections,
}: {
  channel: Exclude<BotImChannel, 'imessage'>;
  connections: readonly BotImConnectionView[];
}) {
  const navigate = useNavigate();
  return <ImCompanionBotsSectionBody channel={channel} connections={connections} onOpenBot={(id) => navigate(`/bots/${encodeURIComponent(id)}?settings=1`)} />;
}

function ImCompanionBotsSectionBody({
  channel,
  connections,
  onOpenBot,
}: {
  channel: Exclude<BotImChannel, 'imessage'>;
  connections: readonly BotImConnectionView[];
  onOpenBot?: (botId: string) => void;
}) {
  const { t } = useTranslation();
  const bots = useBotProfiles();

  return (
    <SettingsSection
      title={t('settings.imBot.companionBots.title')}
      description={t('settings.imBot.companionBots.description')}
    >
      <SettingsCard>
        {connections.map((conn) => {
          const bot = bots.find((item) => item.id === conn.botId);
          const name = bot?.name ?? t('settings.imBot.replyTarget.missingCompanion');
          const identity = conn.identity.username
            ? (channel === 'telegram' ? `@${conn.identity.username}` : conn.identity.username)
            : conn.botContextId
              ? maskBotImContextId(conn.botContextId)
              : null;
          const statusLabel = t(`bots.channels.status.${conn.status.kind}`);
          return (
            <SettingsRow
              key={conn.id}
              title={name}
              hint={
                <ImBotStatusText tone={COMPANION_CONN_TONE[conn.status.kind]}>
                  {[statusLabel, identity].filter(Boolean).join(' · ')}
                </ImBotStatusText>
              }
              value={t('settings.imBot.companionBots.manage')}
              chevron={!!bot && !!onOpenBot}
              onClick={bot && onOpenBot ? () => onOpenBot(bot.id) : undefined}
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
