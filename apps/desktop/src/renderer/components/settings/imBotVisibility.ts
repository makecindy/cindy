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
