/**
 * imBotVisibility —— 「IM 机器人」页按构建区域 + 登录身份的分栏/渠道可见性单点。
 *
 * 产品规则(2026-07-24):中国区构建(cn;dev 行为归 cn 系,见 brandIdentity)
 * 下的**个人账号**(cloud 登录且 membershipKind='personal')不提供官方共享
 * Cindy 机器人分栏与 Discord 机器人入口——个人分栏只保留飞书机器人。
 * 企业账号(org)与 global 构建不受影响;本地模式沿用既有规则(无 Cindy
 * 分栏,Discord 保留)。
 *
 * 纯函数、零组件依赖:ImBotSection 与 ImDefaultSettingsSection 共用,避免
 * 两处条件漂移(ImBotSection 已 import ImDefaultSettingsSection,把条件放
 * 组件文件里会成环)。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

/** 判定可见性所需的最小身份快照(全部来自 useAuth + 构建期区域常量)。 */
export interface ImBotIdentity {
  region: CindyRegion;
  mode: 'signed-out' | 'local' | 'cloud';
  membershipKind: 'personal' | 'org' | null;
}

/** 中国区构建 + 个人账号 cloud 登录(不含企业账号与本地模式)。 */
export function isCnPersonalIdentity(identity: ImBotIdentity): boolean {
  return (
    identity.region !== 'global' &&
    identity.mode === 'cloud' &&
    identity.membershipKind === 'personal'
  );
}

/** 是否提供「Cindy」分栏(官方共享机器人;本地模式与国区个人账号都没有)。 */
export function showCindyGroup(identity: ImBotIdentity): boolean {
  return identity.mode !== 'local' && !isCnPersonalIdentity(identity);
}

/** 个人分栏是否提供 Discord 机器人配置(国区个人账号没有)。 */
export function showDiscordBot(identity: ImBotIdentity): boolean {
  return !isCnPersonalIdentity(identity);
}

/** Lark 在国区只对已登录的云端企业账号开放；global 不受登录模式限制。 */
export function showLarkBot(identity: ImBotIdentity): boolean {
  return (
    identity.region === 'global' || (identity.mode === 'cloud' && identity.membershipKind === 'org')
  );
}

/** 个人分栏是否提供 Telegram 机器人配置 — 可见性规则与 Discord 同组。 */
export function showTelegramBot(identity: ImBotIdentity): boolean {
  return !isCnPersonalIdentity(identity);
}

/**
 * 深链指名了一个当前身份下**根本不存在**的目标 —— 这是能力墙「连接账号」按钮的
 * 落地问题:那颗按钮只按渠道给路由,不判可见性(判了就会在两处各留一份判据、
 * 必然漂移)。于是国区个人账号点「连接 Telegram」会跳到 IM 机器人页,而那张卡
 * 压根没渲染;Slack 更远,它指向的整个「官方」分区都不存在。
 *
 * 正确的收口点在设置页自己 —— 它本来就是可见性的权威。这里给出「你要找的东西
 * 为什么不在」,由页面显示一句说明,而不是让用户对着一页找不到的东西发呆。
 *
 * 只覆盖会被深链指名、又真的可能不可见的三个目标。飞书卡在任何身份下都渲染
 * (Lark 只是它内部的一个开关),微信/企业微信/钉钉同理,都不会落空。
 */
export type UnreachableImBotTargetName = 'cindy-group' | 'discord' | 'telegram';

export interface UnreachableImBotTarget {
  name: UnreachableImBotTargetName;
  /** `cn-personal` = 中国大陆版个人账号不提供;`local-mode` = 没登录 Cindy 账号。 */
  reason: 'cn-personal' | 'local-mode';
}

export function unreachableImBotTarget(
  identity: ImBotIdentity,
  target: { group?: string | null; channel?: string | null },
): UnreachableImBotTarget | null {
  // 渠道比分区具体,先判它。
  if (target.channel === 'discord' && !showDiscordBot(identity)) {
    return { name: 'discord', reason: 'cn-personal' };
  }
  if (target.channel === 'telegram' && !showTelegramBot(identity)) {
    return { name: 'telegram', reason: 'cn-personal' };
  }
  if (target.group === 'cindy' && !showCindyGroup(identity)) {
    return {
      name: 'cindy-group',
      reason: identity.mode === 'local' ? 'local-mode' : 'cn-personal',
    };
  }
  return null;
}
