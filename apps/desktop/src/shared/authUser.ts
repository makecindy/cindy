import type { AuthMembership } from '@cindy/auth-client';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_EFFORT = 'medium';

export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  /** auth-server membership context. */
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  /**
   * 组织 slug(access token 的 orgSlug claim,ctx=org 时 auth-server 注入)。
   * 组织的稳定标识(域名派生、全局唯一,如 'xd'),与 orgId(cuid)/orgName(显示名)
   * 不同,适合做企业功能分流的配置键。个人身份或旧 token 缺 claim 时为 null。
   * membership 响应不含此字段,由 snapshotAuthState 出口统一从 access token 解码注入。
   */
  orgSlug: string | null;
  /** 企业 logo(auth console 组织设置上传);个人身份或未设置为 null。 */
  orgLogoUrl: string | null;
  passportId: string;
}

/**
 * Main-process-only auth user. Keep the raw membership display name separate
 * from `User.name`, whose UI fallback may be an email address or "Cindy".
 */
export interface CurrentUser extends User {
  membershipDisplayName: string;
}


export function mapMembershipToAuthUser(membership: AuthMembership, passportId?: string): CurrentUser {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    membershipDisplayName: membership.displayName,
    // auth-server 自助头像(PATCH /api/me/profile);null = 未设置(UI 首字母兜底)。
    // 产品资料头像回落已随 /api/user/me 退役(2026-07)。
    avatar: membership.avatarUrl ?? null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
    // membership 响应不带 slug;所有出口经 snapshotAuthState 时从 access token 补齐。
    orgSlug: null,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

