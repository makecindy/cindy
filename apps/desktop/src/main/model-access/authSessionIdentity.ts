import type { AuthRegion } from '@cindy/auth-client';

export interface AuthSessionIdentity {
  userId: string | null;
  realm: AuthRegion | null;
}

/**
 * 已建立身份的 userId 或 realm 任一变化都跨越认证边界。首次获知身份不算切换，
 * 避免初始化订阅与补读当前状态时重复作废同一轮请求。
 */
export function hasAuthSessionIdentityChanged(
  previous: AuthSessionIdentity,
  next: AuthSessionIdentity,
): boolean {
  return (
    (previous.userId !== null && next.userId !== null && previous.userId !== next.userId) ||
    (previous.realm !== null && next.realm !== null && previous.realm !== next.realm)
  );
}
