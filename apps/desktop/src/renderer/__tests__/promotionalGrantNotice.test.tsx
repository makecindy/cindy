// @vitest-environment jsdom

/**
 * 「赠送余额已到账」一次性告知的判定、账号隔离与已读记账。
 *
 * 回归的是开通后的静默:服务端在开通 Cindy AI 时发一笔限期赠送余额，而金额与有效期的唯一
 * 展示位是计费页（设置 → 用量和计费）——用户走不到那儿（供应商卡片 2026-07-20 刻意剥离了
 * 计费展示），于是可能到过期都不知道账上有钱。这张卡补的是「已经发生的事要告知一次」。
 *
 * 三条不能退的判据在这里各有用例:企业账号**不渲染**（不是灰置，也不该为它发请求）、
 * 拿不到明细就不出卡（宁可不提醒，也不印占位金额）、已读态按账号 + grant 记账（换账号后
 * 新账号自己那笔必须还能告知一次）。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ModelAccessCreditUsage,
  ModelAccessPromotionalGrantUsage,
} from '../../shared/modelAccess';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const auth = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  membershipKind: 'personal' as 'personal' | 'org' | null,
  dataOwnerId: 'account-a' as string | null,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: auth.mode,
    dataOwnerId: auth.dataOwnerId,
    user: auth.membershipKind ? { membershipKind: auth.membershipKind } : null,
  }),
}));

// CN 区固定:金额格式化要有确定的币种，否则断言随构建区域漂移。
vi.mock('../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

function grant(over: Partial<ModelAccessPromotionalGrantUsage> = {}): ModelAccessPromotionalGrantUsage {
  return {
    grantId: 'grant-1',
    displayName: 'New user grant',
    originalAmount: '20',
    usedAmount: '0',
    remainingAmount: '20',
    expiresAt: '2026-08-30T15:59:00.000Z',
    state: 'active',
    ...over,
  };
}

function usage(grants: ModelAccessPromotionalGrantUsage[]): ModelAccessCreditUsage {
  const pool = { remaining: '20', used: '0', total: '20' };
  return {
    available: '20',
    plan: pool,
    purchased: pool,
    promotional: pool,
    promotionalGrants: grants,
    promotionalGrantsComplete: true,
    promotionalGrantConsistency: 'OBSERVED',
    ledgerUpdatedAt: '2026-08-01T00:00:00.000Z',
    scale: 9,
    observedAt: '2026-08-01T00:00:00.000Z',
  };
}

const ledger = vi.hoisted(() => ({
  getCreditUsage: undefined as unknown as ReturnType<typeof vi.fn>,
}));

let storage: MemLocalStorage;

beforeEach(() => {
  vi.resetModules();
  navigate.mockClear();
  auth.mode = 'cloud';
  auth.membershipKind = 'personal';
  auth.dataOwnerId = 'account-a';
  ledger.getCreditUsage = vi.fn(async () => usage([grant()]));
  storage = new MemLocalStorage();
  stubWindow();
});

function stubWindow(): void {
  vi.stubGlobal('window', {
    ...globalThis.window,
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: { billing: { getCreditUsage: ledger.getCreditUsage } },
  });
  vi.stubGlobal('localStorage', storage);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderNotice(enabled = true): Promise<void> {
  const { PromotionalGrantNotice } = await import('@/components/onboarding/PromotionalGrantNotice');
  await act(async () => {
    render(<PromotionalGrantNotice enabled={enabled} />);
  });
}

function noticeText(): string {
  return screen.getByTestId('promotional-grant-notice').textContent ?? '';
}

describe('PromotionalGrantNotice', () => {
  it('个人云账号有一笔生效中赠送 → 告知出现，金额与有效期都来自那笔 grant', async () => {
    await renderNotice();

    const text = noticeText();
    expect(text).toContain('onboarding.promotionalGrant.title');
    // 金额走 formatBillingAmount(CN 区 = CNY),不是把服务端字符串直接印上去。
    expect(text).toContain('20.00');
    expect(text).toContain('2026');
  });

  it('企业账号不渲染，也不为它去拉账本', async () => {
    // org 账号在整个计费面上都是「不渲染」而非灰置(canAccessBillingSettings 同一判据);
    // 顺带保证不发无谓的请求 —— 服务端对 org 会直接拒。
    auth.membershipKind = 'org';
    await renderNotice();

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
    expect(ledger.getCreditUsage).not.toHaveBeenCalled();
  });

  it('本地模式 / 未登录不渲染', async () => {
    auth.mode = 'local';
    auth.membershipKind = null;
    await renderNotice();

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
    expect(ledger.getCreditUsage).not.toHaveBeenCalled();
  });

  it('device-link 草稿(enabled=false)不出现，也不拉账本', async () => {
    await renderNotice(false);

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
    expect(ledger.getCreditUsage).not.toHaveBeenCalled();
  });

  it('拿不到赠送明细 → 不出这张卡(不印占位金额)', async () => {
    ledger.getCreditUsage = vi.fn(async () => {
      throw new Error('BALANCE_NOT_SUPPORTED');
    });
    stubWindow();
    await renderNotice();

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
  });

  it('只有已用完 / 已过期 / 已作废的赠送 → 不出现', async () => {
    ledger.getCreditUsage = vi.fn(async () =>
      usage([
        grant({ grantId: 'g-depleted', state: 'depleted' }),
        grant({ grantId: 'g-expired', state: 'expired' }),
        grant({ grantId: 'g-voided', state: 'voided' }),
      ]),
    );
    stubWindow();
    await renderNotice();

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
  });

  it('有效期解析不出来的 grant 不命中 —— 卡上必须印得出具体日期', async () => {
    ledger.getCreditUsage = vi.fn(async () => usage([grant({ expiresAt: 'not-a-date' })]));
    stubWindow();
    await renderNotice();

    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
  });

  it('多笔生效中时取有效期最晚的那笔', async () => {
    ledger.getCreditUsage = vi.fn(async () =>
      usage([
        grant({ grantId: 'g-early', originalAmount: '5', expiresAt: '2026-08-10T00:00:00.000Z' }),
        grant({ grantId: 'g-late', originalAmount: '30', expiresAt: '2026-09-20T00:00:00.000Z' }),
      ]),
    );
    stubWindow();
    await renderNotice();

    expect(noticeText()).toContain('30.00');
  });

  it('点「知道了」后写入已读，重新挂载不再出现', async () => {
    await renderNotice();

    await act(async () => {
      screen.getByText('onboarding.promotionalGrant.acknowledge').click();
    });
    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();

    // 冷启动重来(同一份 localStorage)→ 一次性告知不该回弹。
    cleanup();
    await renderNotice();
    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
  });

  it('「查看用量」同时记已读并跳计费页 —— 否则回到首屏它还在', async () => {
    await renderNotice();

    await act(async () => {
      screen.getByText('onboarding.promotionalGrant.openBilling').click();
    });
    expect(navigate).toHaveBeenCalledWith('/settings?tab=billing');

    cleanup();
    await renderNotice();
    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();
  });

  it('已读态按账号隔离:换账号后同一 grantId 仍会告知一次', async () => {
    await renderNotice();
    await act(async () => {
      screen.getByText('onboarding.promotionalGrant.acknowledge').click();
    });
    expect(screen.queryByTestId('promotional-grant-notice')).toBeNull();

    // 同一台机器换账号登录:新账号自己那笔赠送必须还能被告知,否则漏告知且查不出来。
    cleanup();
    auth.dataOwnerId = 'account-b';
    await renderNotice();
    expect(screen.getByTestId('promotional-grant-notice')).toBeTruthy();
  });

  it('另一笔新 grant 仍会告知(按 grant 记账，不是按账号一刀切)', async () => {
    const { acknowledgePromotionalGrant } = await import('@/state/promotionalGrantNotice');
    acknowledgePromotionalGrant('account-a', 'grant-1');

    ledger.getCreditUsage = vi.fn(async () => usage([grant({ grantId: 'grant-2' })]));
    stubWindow();
    await renderNotice();

    expect(screen.getByTestId('promotional-grant-notice')).toBeTruthy();
  });

  it('最晚到期那笔已读时,更早到期的未读赠送仍会告知(未读过滤先于挑选)', async () => {
    // 场景:运营补发了一笔更晚到期的赠送、用户读过;更早那笔从未告知。
    // 若先挑「最晚一笔」再看已读,已读的最晚笔会把未读的早笔永远遮蔽掉。
    const { acknowledgePromotionalGrant } = await import('@/state/promotionalGrantNotice');
    acknowledgePromotionalGrant('account-a', 'grant-late');

    ledger.getCreditUsage = vi.fn(async () =>
      usage([
        grant({ grantId: 'grant-late', expiresAt: '2026-09-30T15:59:00.000Z', originalAmount: '50' }),
        grant({ grantId: 'grant-early', expiresAt: '2026-08-30T15:59:00.000Z', originalAmount: '20' }),
      ]),
    );
    stubWindow();
    await renderNotice();

    // 出的是未读的早笔(金额 20),不是已读的晚笔,也不是不出。
    expect(noticeText()).toContain('20.00');
  });

  it('localStorage 持续不可用时,同会话连续确认与跨账号确认都不丢(内存兜底做并集)', async () => {
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    stubWindow();
    const state = await import('@/state/promotionalGrantNotice');

    state.acknowledgePromotionalGrant('account-a', 'grant-1');
    // 第二次确认(换了账号)不能把第一次的内存记录整份覆盖掉。
    state.acknowledgePromotionalGrant('account-b', 'grant-2');

    const snapshot = state.getAcknowledgedPromotionalGrants();
    expect(state.isPromotionalGrantAcknowledged(snapshot, 'account-a', 'grant-1')).toBe(true);
    expect(state.isPromotionalGrantAcknowledged(snapshot, 'account-b', 'grant-2')).toBe(true);
  });
});
