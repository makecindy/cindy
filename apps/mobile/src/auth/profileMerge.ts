/**
 * profileMerge.ts — 登录身份(auth-server membership)的展示态映射纯函数,
 * 从 AuthContext 抽出以便单测(authProfileMerge.test.ts)。
 *
 * 2026-07 起身份完全以 auth-server membership 为真源:产品 /api/user/me 已
 * 退役(isCanary/feishuId/role 增强字段一并下线),不再有产品资料合并段,
 * 与 desktop authManager 同语义。头像 null = 未设置,UI 首字母兜底。
 */

import type { AuthMembership } from '@cindy/auth-client';

import type { MobileUser } from './AuthContext';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_EFFORT = 'medium';

export function mapMembershipToMobileUser(
  membership: AuthMembership,
  passportId?: string,
): MobileUser {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    // auth-server 自助头像(PATCH /api/me/profile);null = 未设置(首字母兜底)。
    avatar: membership.avatarUrl ?? null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

export function mergeMembershipWithExisting(
  membership: AuthMembership,
  existing: MobileUser | null,
  passportId?: string,
): MobileUser {
  const mapped = mapMembershipToMobileUser(membership, passportId);
  if (!existing || existing.id !== mapped.id) return mapped;
  return {
    ...mapped,
    // membership 自助头像优先;未设置时保留既有展示值。
    avatar: mapped.avatar ?? existing.avatar,
    defaultModel: existing.defaultModel,
    defaultEffort: existing.defaultEffort,
    passportId: mapped.passportId || existing.passportId,
    orgLogoUrl: mapped.orgLogoUrl ?? existing.orgLogoUrl ?? null,
  };
}
