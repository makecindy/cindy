/**
 * usePromotionalGrantNotice —— 判定「开通 Cindy AI 后到账的那笔赠送余额该不该告知一次」，
 * 并把它做成一条一次性告知。
 *
 * 补的缺口:赠送余额是服务端在开通时自动发的一笔限期余额,客户端此前完全静默 —— 金额与
 * 有效期的唯一展示位是计费页(设置 → 用量和计费),而用户走不到那儿(供应商卡片 2026-07-20
 * 刻意剥离了计费展示)。结果是用户可能到过期都不知道账上有钱。
 *
 * 判定用四个条件,缺一不可:
 *   1. 调用方 gate(device-link 草稿等场景传 false);
 *   2. 当前身份能看计费(`canAccessBillingSettings` —— 企业账号是**不渲染**,不是灰置);
 *   3. 账本里确实有一笔生效中的赠送(`state === 'active'`),金额与有效期都取自它;
 *   4. 这笔赠送对这个账号还没被告知过。
 *
 * 第 3 条是硬要求:拿不到明细(租户不提供该查询 / 未开户 / 请求失败,hook 一律返 null)时
 * **不出这张卡** —— 告知的全部价值就是那两个具体数字,拿金额占位符去提醒用户比不提醒更糟。
 *
 * 「生效中」有多笔时取有效期最晚的那笔:新用户只有一笔,而多笔时最晚到期的那笔才是用户接下来
 * 真正会花到的钱;并列时按 grantId 定序,免得同一份数据在两次渲染里挑出不同的 grant。
 */

import { useMemo, useSyncExternalStore } from 'react';

import { canAccessBillingSettings } from '@/components/settings/billingVisibility';
import { useAuth } from '@/contexts/AuthContext';
import { useModelAccessCreditUsage } from '@/hooks/useModelAccessCreditUsage';
import type { ModelAccessPromotionalGrantUsage } from '../../shared/modelAccess';
import {
  acknowledgePromotionalGrant,
  getAcknowledgedPromotionalGrants,
  isPromotionalGrantAcknowledged,
  subscribePromotionalGrantNotice,
} from '@/state/promotionalGrantNotice';

export interface UsePromotionalGrantNoticeReturn {
  /** 是否该展示告知(有一笔未读的生效中赠送)。 */
  visible: boolean;
  /** 命中的那笔赠送(金额与有效期的来源);不可见时为 null。 */
  grant: ModelAccessPromotionalGrantUsage | null;
  /** 标记已读(一次性,不再出现)。 */
  acknowledge: () => void;
}

/**
 * 生效中、**且尚未告知过**的赠送里有效期最晚的那笔;并列按 grantId 定序保证结果稳定。
 *
 * 「未读」过滤必须发生在挑选**之前**:若先挑最晚一笔再看它读没读,一笔已读的最晚
 * 赠送会遮蔽其它仍未读的生效赠送(例如运营补发了一笔更晚到期的、用户读过,而更早
 * 那笔从未告知)——那些赠送就永远失去了唯一的告知机会。
 */
function activeUnacknowledgedGrantOf(
  grants: readonly ModelAccessPromotionalGrantUsage[],
  acknowledgedSnapshot: string,
  accountId: string,
): ModelAccessPromotionalGrantUsage | null {
  let best: ModelAccessPromotionalGrantUsage | null = null;
  let bestExpiry = Number.NEGATIVE_INFINITY;
  for (const grant of grants) {
    if (grant.state !== 'active') continue;
    // 解析不出有效期的行直接跳过:卡上要印这个日期,印不出来的不该命中。
    const expiry = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiry)) continue;
    if (isPromotionalGrantAcknowledged(acknowledgedSnapshot, accountId, grant.grantId)) continue;
    if (best === null || expiry > bestExpiry || (expiry === bestExpiry && grant.grantId > best.grantId)) {
      best = grant;
      bestExpiry = expiry;
    }
  }
  return best;
}

/**
 * @param enabled 调用方 gate(device-link 草稿传 false:那条对话跑在被控端,本机账号的
 *   赠送余额与它无关)。false 时连账本都不拉。
 */
export function usePromotionalGrantNotice(enabled = true): UsePromotionalGrantNoticeReturn {
  const { mode, user, dataOwnerId } = useAuth();
  const billingVisible = canAccessBillingSettings({
    mode,
    membershipKind: user?.membershipKind ?? null,
  });
  // 账本请求跟着 gate 走:企业账号 / 未登录 / device-link 草稿一律不发请求。
  const creditUsage = useModelAccessCreditUsage(enabled && billingVisible);

  const acknowledgedSnapshot = useSyncExternalStore(
    subscribePromotionalGrantNotice,
    getAcknowledgedPromotionalGrants,
  );

  const grant = useMemo(() => {
    if (!enabled || !billingVisible || !dataOwnerId || !creditUsage) return null;
    return activeUnacknowledgedGrantOf(
      creditUsage.promotionalGrants,
      acknowledgedSnapshot,
      dataOwnerId,
    );
  }, [enabled, billingVisible, dataOwnerId, creditUsage, acknowledgedSnapshot]);

  const acknowledge = useMemo(() => {
    const accountId = dataOwnerId;
    const grantId = grant?.grantId;
    return () => {
      if (!accountId || !grantId) return;
      acknowledgePromotionalGrant(accountId, grantId);
    };
  }, [dataOwnerId, grant?.grantId]);

  return { visible: grant !== null, grant, acknowledge };
}
