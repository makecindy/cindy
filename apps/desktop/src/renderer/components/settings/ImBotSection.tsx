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
 *   3. 插件:声明 imEntrance 的已启用插件(没有时不显示)。它们读官方机器人那份
 *      「项目与模型」；本地模式没有官方分栏时，这一块随插件分栏显示。
 *
 * ?imGroup= 参数仍由 SettingsView 驱动,但只负责把深链滚动到对应分区；缺省时
 * 保持页面顶部不动,旧「飞书机器人」深链继续定位到「个人」。
 * Beta 标识用一颗 pill(主题 token,无硬编码 hex),表示整块功能处于 Beta。
 *
 * 可见性(imBotVisibility 单点):本地模式没有 Cindy 分栏，深链落「个人」。
 * 个人机器人在各构建与账号中都显示。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';

import { useAuth } from '@/contexts/AuthContext';
import { DiscordBotSection } from './DiscordBotSection';
import { DingTalkBotSection } from './DingTalkBotSection';
import { FeishuBotSection } from './FeishuBotSection';
import { HookConnectionsSection } from './HookConnectionsSection';
import { ImPluginEntrancesCard, useImEntrancePlugins } from './ImPluginEntrances';
import { TelegramBotSection } from './TelegramBotSection';
import { WechatBotSection } from './WechatBotSection';
import { WecomBotSection } from './WecomBotSection';
import { showCindyGroup } from './imBotVisibility';

import { ImBotSettingsFrame, ImBotGroupSection } from './ImBotSettingsLayout';

/** 「IM 机器人」页面分区 id(与 ?imGroup= 参数共用)。 */
export type ImBotSettingsGroup = 'cindy' | 'personal';

export function isImBotSettingsGroup(value: string | null): value is ImBotSettingsGroup {
  return value === 'cindy' || value === 'personal';
}

/** 个人栏内容 —— 用户自配凭证的机器人。 */
function PersonalGroupContent({
  targetChannel,
  preferredFeishuService,
  activation,
}: {
  targetChannel: 'wechat' | 'wecom' | 'feishu' | 'discord' | 'telegram' | 'dingtalk' | null;
  preferredFeishuService: 'feishu' | 'lark' | null;
  activation: number;
}) {
  const [expandedChannel, setExpandedChannel] = useState<
    'wechat' | 'wecom' | 'feishu' | 'discord' | 'telegram' | 'dingtalk' | null
  >(targetChannel);

  useLayoutEffect(() => {
    if (targetChannel) setExpandedChannel(targetChannel);
  }, [targetChannel, activation]);

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
        preferredService={preferredFeishuService}
        searchActivation={activation}
      />
      <DingTalkBotSection
        expanded={expandedChannel === 'dingtalk'}
        onToggle={() => toggle('dingtalk')}
      />
      <DiscordBotSection
        expanded={expandedChannel === 'discord'}
        onToggle={() => toggle('discord')}
      />
      <TelegramBotSection
        expanded={expandedChannel === 'telegram'}
        onToggle={() => toggle('telegram')}
      />
    </div>
  );
}

export function ImBotSection({ targetGroup }: { targetGroup: ImBotSettingsGroup | null }) {
  const { mode, dataOwnerId } = useAuth();
  const { entry, activation } = useSettingsSearchNavigation();
  const cindyGroupAvailable = showCindyGroup({ mode });
  const imPlugins = useImEntrancePlugins();
  const targetChannel =
    (['wechat', 'wecom', 'feishu', 'discord', 'telegram', 'dingtalk'] as const).find(
      (channel) => entry?.targetId === 'personal-im-' + channel,
    ) ?? null;
  const preferredFeishuService =
    entry?.id === 'imBot.lark' ? 'lark' : entry?.id === 'imBot.feishu' ? 'feishu' : null;
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
    <ImBotSettingsFrame contentKey={`${mode}:${dataOwnerId ?? 'none'}`}>
      {cindyGroupAvailable && (
        <ImBotGroupSection group="cindy" sectionRef={cindySectionRef}>
          <HookConnectionsSection />
        </ImBotGroupSection>
      )}
      <ImBotGroupSection group="personal" sectionRef={personalSectionRef}>
        <PersonalGroupContent
          targetChannel={targetChannel}
          preferredFeishuService={preferredFeishuService}
          activation={activation}
        />
      </ImBotGroupSection>
      {imPlugins.length > 0 && (
        <ImBotGroupSection group="plugins">
          <ImPluginEntrancesCard plugins={imPlugins} />
          {!cindyGroupAvailable && <HookConnectionsSection projectsOnly />}
        </ImBotGroupSection>
      )}
    </ImBotSettingsFrame>
  );
}
