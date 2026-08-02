/**
 * ImBotSection —— 「IM 机器人」设置页(单页 + 官方/个人纵向分区)。
 *
 * 侧边栏「IM 机器人」是普通 cell(不再有可展开的子 cell),内容整合在本页。
 * 官方与个人分区同时渲染、上下排列,避免 tab 把另一组支持的机器人类型藏起来；
 * 每个分区配一条简短 Tips 说明差异:
 *   1. Cindy(group='cindy',默认):官方 Cindy 机器人渠道 —— 多渠道卡片
 *      (HookConnectionsSection,原 Tina 设置区,由 Cindy 维护、用户零凭证)
 *   2. 个人(group='personal'):按渠道折叠的用户自配机器人。每个渠道独立保存
 *      Agent / 模型与凭证配置；同一时刻最多展开一个，渠道增加时页面不会线性变长。
 *
 * ?imGroup= 参数仍由 SettingsView 驱动,但只负责把深链滚动到对应分区；缺省时
 * 保持页面顶部不动,旧「飞书机器人」深链继续定位到「个人」。
 * Beta 标识用一颗 pill(主题 token,无硬编码 hex),表示整块功能处于 Beta。
 *
 * 可见性(imBotVisibility 单点):本地模式与「国区构建 + 个人账号登录」都
 * 没有 Cindy 分栏(深链/兜底一律落「个人」);国区个人账号的个人分栏进一步
 * 隐藏 Discord / Telegram 机器人，保留中国大陆可用的个人连接。
 */

import { Lightbulb } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { DiscordBotSection } from './DiscordBotSection';
import { DingTalkBotSection } from './DingTalkBotSection';
import { FeishuBotSection } from './FeishuBotSection';
import { HookConnectionsSection } from './HookConnectionsSection';
import { TelegramBotSection } from './TelegramBotSection';
import { WechatBotSection } from './WechatBotSection';
import { WecomBotSection } from './WecomBotSection';
import {
  showCindyGroup,
  showDiscordBot,
  showLarkBot,
  showTelegramBot,
  type ImBotIdentity,
} from './imBotVisibility';

/** 「IM 机器人」页面分区 id(与 ?imGroup= 参数共用)。 */
export type ImBotSettingsGroup = 'cindy' | 'personal';

/** 分区标题的 i18n key。 */
const IM_BOT_GROUP_LABEL_KEY: Record<ImBotSettingsGroup, string> = {
  cindy: 'settings.imBot.groups.cindy',
  personal: 'settings.imBot.groups.personal',
};

/** 分区 Tips 的 i18n key —— 一句话讲清该分区是什么、与另一区的差异。 */
const IM_BOT_GROUP_TIP_KEY: Record<ImBotSettingsGroup, string> = {
  cindy: 'settings.imBot.tips.cindy',
  personal: 'settings.imBot.tips.personal',
};

function GroupTip({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-chip)] px-3.5 py-2.5">
      <Lightbulb size={14} className="mt-[2px] shrink-0 text-[var(--text-tertiary)]" />
      <p className="text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">{message}</p>
    </div>
  );
}

export function isImBotSettingsGroup(value: string | null): value is ImBotSettingsGroup {
  return value === 'cindy' || value === 'personal';
}

/** 个人栏内容 —— 用户自配凭证的机器人(国区个人账号无 Discord/Lark/Telegram)。 */
function PersonalGroupContent({
  showDiscord,
  showLark,
  showTelegram,
}: {
  showDiscord: boolean;
  showLark: boolean;
  showTelegram: boolean;
}) {
  const [expandedChannel, setExpandedChannel] = useState<
    'wechat' | 'wecom' | 'feishu' | 'discord' | 'telegram' | 'dingtalk' | null
  >(null);

  const toggle = (channel: 'wechat' | 'wecom' | 'feishu' | 'discord' | 'telegram' | 'dingtalk') => {
    setExpandedChannel((current) => (current === channel ? null : channel));
  };

  return (
    <div className="flex flex-col gap-3">
      <WechatBotSection expanded={expandedChannel === 'wechat'} onToggle={() => toggle('wechat')} />
      <WecomBotSection expanded={expandedChannel === 'wecom'} onToggle={() => toggle('wecom')} />
      <FeishuBotSection
        expanded={expandedChannel === 'feishu'}
        onToggle={() => toggle('feishu')}
        showLark={showLark}
      />
      <DingTalkBotSection
        expanded={expandedChannel === 'dingtalk'}
        onToggle={() => toggle('dingtalk')}
      />
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

export function ImBotSection({ targetGroup }: { targetGroup: ImBotSettingsGroup | null }) {
  const { t } = useTranslation();
  const { mode, dataOwnerId, user } = useAuth();
  const identity: ImBotIdentity = {
    region: CURRENT_CINDY_REGION,
    mode,
    membershipKind: user?.membershipKind ?? null,
  };
  const cindyGroupAvailable = showCindyGroup(identity);
  const discordVisible = showDiscordBot(identity);
  const larkVisible = showLarkBot(identity);
  const telegramVisible = showTelegramBot(identity);
  const cindySectionRef = useRef<HTMLElement | null>(null);
  const personalSectionRef = useRef<HTMLElement | null>(null);
  const effectiveTargetGroup = targetGroup
    ? cindyGroupAvailable
      ? targetGroup
      : 'personal'
    : null;

  useEffect(() => {
    if (!effectiveTargetGroup) return;
    const section =
      effectiveTargetGroup === 'cindy' ? cindySectionRef.current : personalSectionRef.current;
    if (!section) return;

    // SettingsView 切 tab 时会先把外层滚动容器回顶；下一帧再处理分区深链，
    // 避免父级回顶覆盖 personal 定位。
    const frame = window.requestAnimationFrame(() => {
      section.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveTargetGroup]);

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

      <div key={`${mode}:${dataOwnerId ?? 'none'}`} className="mt-4 flex flex-col gap-8">
        {cindyGroupAvailable && (
          <section
            ref={cindySectionRef}
            id="im-bot-group-cindy"
            aria-labelledby="im-bot-group-heading-cindy"
            className="flex scroll-mt-4 flex-col gap-3"
          >
            <h3
              id="im-bot-group-heading-cindy"
              className="text-14 font-medium leading-[1.4] text-[var(--settings-section-title)]"
            >
              {t(IM_BOT_GROUP_LABEL_KEY.cindy)}
            </h3>
            <GroupTip message={t(IM_BOT_GROUP_TIP_KEY.cindy)} />
            <HookConnectionsSection />
          </section>
        )}

        <section
          ref={personalSectionRef}
          id="im-bot-group-personal"
          aria-labelledby="im-bot-group-heading-personal"
          className="flex scroll-mt-4 flex-col gap-3"
        >
          <h3
            id="im-bot-group-heading-personal"
            className="text-14 font-medium leading-[1.4] text-[var(--settings-section-title)]"
          >
            {t(IM_BOT_GROUP_LABEL_KEY.personal)}
          </h3>
          <GroupTip message={t(IM_BOT_GROUP_TIP_KEY.personal)} />
          <PersonalGroupContent
            showDiscord={discordVisible}
            showLark={larkVisible}
            showTelegram={telegramVisible}
          />
        </section>
      </div>
    </div>
  );
}
