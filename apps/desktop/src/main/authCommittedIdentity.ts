export interface CommittedAuthIdentity {
  userId: string;
  membershipKind: 'personal' | 'org';
  isAuthenticated: boolean;
}

/** 只投影传入的内存身份与令牌是否存在；不初始化鉴权、不读凭据，也不返回令牌或用户资料。 */
export function projectCommittedAuthIdentity(
  user: { readonly id?: unknown; readonly membershipKind?: unknown } | null | undefined,
  accessToken: unknown,
): CommittedAuthIdentity | null {
  if (!user || typeof user.id !== 'string' || !user.id
    || (user.membershipKind !== 'personal' && user.membershipKind !== 'org')) return null;
  return {
    userId: user.id,
    membershipKind: user.membershipKind,
    isAuthenticated: typeof accessToken === 'string' && accessToken.length > 0,
  };
}
