/**
 * ImBotSection —— 「IM 机器人」设置页(单页 + 页内分栏 tab)。
 *
 * 侧边栏「IM 机器人」是普通 cell(不再有可展开的子 cell),内容整合在本页,
 * 顶部用 pill 分段 tab 切换两个分栏(视觉对齐 ImDefaultSettingsSection 的
 * agent 切换器 / VendorSegmentedSwitcher),每个分栏配一条简短 Tips 说明差异:
 *   1. Cindy(group='cindy',默认):官方 Cindy 机器人渠道 —— Slack 卡片
 *      (HookConnectionsSection,原 Tina 设置区,共享 App 零凭证)
 *   2. 个人(group='personal'):按渠道折叠的用户自配机器人。每个渠道独立保存
 *      Agent / 模型与凭证配置；同一时刻最多展开一个，渠道增加时页面不会线性变长。
 *
 * 分栏选择经 ?imGroup= 参数由 SettingsView 驱动(深链可直达某分栏);缺省/非法
 * 时 SettingsView 落到默认分栏(旧「飞书机器人」深链落「个人」,其余落「Cindy」)。
 * Beta 标识用一颗 pill(主题 token,无硬编码 hex),表示整块功能处于 Beta。
 *
 * 可见性(imBotVisibility 单点):本地模式与「国区构建 + 个人账号登录」都
 * 没有 Cindy 分栏(深链/兜底一律落「个人」);国区个人账号的个人分栏进一步
 * 隐藏 Discord 机器人,只剩飞书(Tips 换 personalFeishuOnly 文案)。
 */

import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { DiscordBotSection } from './DiscordBotSection';
import { FeishuBotSection } from './FeishuBotSection';
import { HookConnectionsSection } from './HookConnectionsSection';
import { TelegramBotSection } from './TelegramBotSection';
import { WechatBotSection } from './WechatBotSection';
import {
  showCindyGroup,
  showDiscordBot,
  showTelegramBot,
  type ImBotIdentity,
} from './imBotVisibility';

/** 「IM 机器人」页内分栏 id(tab 与 ?imGroup= 参数共用)。 */
export type ImBotSettingsGroup = 'cindy' | 'personal';

/** 分栏 tab 的固定顺序(Cindy 在前为默认)。 */
export const IM_BOT_SETTINGS_GROUPS: readonly ImBotSettingsGroup[] = ['cindy', 'personal'];
const PERSONAL_ONLY_IM_BOT_SETTINGS_GROUPS: readonly ImBotSettingsGroup[] = ['personal'];

/** 分栏标题的 i18n key(tab 文案)。 */
export const IM_BOT_GROUP_LABEL_KEY: Record<ImBotSettingsGroup, string> = {
  cindy: 'settings.imBot.groups.cindy',
  personal: 'settings.imBot.groups.personal',
};

/** 分栏 Tips 的 i18n key —— 一句话讲清该分栏是什么、与另一栏的差异。 */
const IM_BOT_GROUP_TIP_KEY: Record<ImBotSettingsGroup, string> = {
  cindy: 'settings.imBot.tips.cindy',
  personal: 'settings.imBot.tips.personal',
};

export function isImBotSettingsGroup(value: string | null): value is ImBotSettingsGroup {
  return value === 'cindy' || value === 'personal';
}

/** 个人栏内容 —— 用户自配凭证的机器人(国区个人账号无 Discord/Telegram)。 */
function PersonalGroupContent({
  showDiscord,
  showTelegram,
}: {
  showDiscord: boolean;
  showTelegram: boolean;
}) {
  const [expandedChannel, setExpandedChannel] = useState<
    'wechat' | 'feishu' | 'discord' | 'telegram' | null
  >(null);

  const toggle = (channel: 'wechat' | 'feishu' | 'discord' | 'telegram') => {
    setExpandedChannel((current) => (current === channel ? null : channel));
  };

  return (
    <div className="flex flex-col gap-3">
      <WechatBotSection expanded={expandedChannel === 'wechat'} onToggle={() => toggle('wechat')} />
      <FeishuBotSection expanded={expandedChannel === 'feishu'} onToggle={() => toggle('feishu')} />
      {showDiscord && (
        <DiscordBotSection
          expanded={expandedChannel === 'discord'}
          onToggle={() => toggle('discord')}
        />
      )}
      {showTelegram && (
        <TelegramBotSection
          expanded={expandedChannel === 'telegram'}
          onToggle={() => toggle('telegram')}
        />
      )}
    </div>
  );
}

export function ImBotSection({
  group,
  onGroupChange,
}: {
  group: ImBotSettingsGroup;
  onGroupChange: (group: ImBotSettingsGroup) => void;
}) {
  const { t } = useTranslation();
  const { mode, dataOwnerId, user } = useAuth();
  const identity: ImBotIdentity = {
    region: CURRENT_CINDY_REGION,
    mode,
    membershipKind: user?.membershipKind ?? null,
  };
  const cindyGroupAvailable = showCindyGroup(identity);
  const discordVisible = showDiscordBot(identity);
  const telegramVisible = showTelegramBot(identity);
  const availableGroups = cindyGroupAvailable
    ? IM_BOT_SETTINGS_GROUPS
    : PERSONAL_ONLY_IM_BOT_SETTINGS_GROUPS;
  const effectiveGroup = cindyGroupAvailable ? group : 'personal';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.sections.imBot')}
        </h2>
        <span className="rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-[1px] text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
          {t('settings.imBot.beta')}
        </span>
      </div>

      {/* 分栏 pill tab —— 视觉对齐 ImDefaultSettingsSection 的 agent 切换器 */}
      <div
        className="mt-3 flex h-9 w-[220px] items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-[3px]"
        role="tablist"
        aria-label={t('settings.sections.imBot')}
      >
        {availableGroups.map((g) => {
          const active = g === effectiveGroup;
          return (
            <button
              key={g}
              type="button"
              role="tab"
              id={`im-bot-group-tab-${g}`}
              aria-selected={active}
              aria-controls={`im-bot-group-panel-${g}`}
              onClick={() => {
                if (!active) onGroupChange(g);
              }}
              className={cn(
                'flex h-full min-w-0 flex-1 items-center justify-center rounded-full px-3',
                'border text-[13px] leading-none transition-colors',
                active
                  ? 'border-[var(--border-default)] bg-[var(--surface-elevated)] font-medium text-[var(--settings-section-title)]'
                  : 'border-transparent font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              <span className="truncate">{t(IM_BOT_GROUP_LABEL_KEY[g])}</span>
            </button>
          );
        })}
      </div>

      {/* Tips —— 一句话讲清当前分栏与另一栏的差异 */}
      <div className="mt-2 flex items-start gap-2 rounded-lg bg-[var(--surface-chip)] px-3.5 py-2.5">
        <Lightbulb size={14} className="mt-[2px] shrink-0 text-[var(--text-tertiary)]" />
        <p className="text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
          {t(
            effectiveGroup === 'personal' && !discordVisible
              ? 'settings.imBot.tips.personalFeishuOnly'
              : IM_BOT_GROUP_TIP_KEY[effectiveGroup],
          )}
        </p>
      </div>

      <div
        key={`${mode}:${dataOwnerId ?? 'none'}`}
        role="tabpanel"
        id={`im-bot-group-panel-${effectiveGroup}`}
        aria-labelledby={`im-bot-group-tab-${effectiveGroup}`}
        className="mt-4 flex flex-col gap-8"
      >
        {effectiveGroup === 'cindy' ? (
          <HookConnectionsSection />
        ) : (
          <PersonalGroupContent showDiscord={discordVisible} showTelegram={telegramVisible} />
        )}
      </div>
    </div>
  );
}
