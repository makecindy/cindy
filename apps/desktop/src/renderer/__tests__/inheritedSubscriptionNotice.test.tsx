// @vitest-environment jsdom

/**
 * 「已沿用本机订阅」一次性告知的判定与已读记账。
 *
 * 回归的是首启的静默继承：本机装过并登录过 codex / claude CLI 时，Cindy 会把那份凭证认领到
 * 当前账号（设计内的自动继承）。自动发现是产品原则，但认领完全静默 —— 而既有的「连接供应商」
 * 引导以「零已连接来源」为前提，继承成功后该供应商已连接，那张卡压根不出现。于是这条路径上的
 * 用户既不知道 Cindy 用的是他机器上哪个账号，也不知道去哪儿换。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import type { LocalCliDetection } from '../../shared/localCliDetect';

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

const h = vi.hoisted(() => ({
  providers: [] as ProviderView[],
  loading: false,
  detections: [] as LocalCliDetection[],
  scanCalls: 0,
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: h.providers, loading: h.loading }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.products ? `${key}:${String(opts.products)}` : key,
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

function provider(id: string, connected: boolean, product?: string): ProviderView {
  return {
    id,
    name: id === 'openai' ? 'OpenAI' : 'Anthropic',
    source: 'builtin',
    agents: ['codex'],
    models: {},
    routing: {},
    auth: { method: 'oauth' },
    connected,
    ...(product ? { access: { kind: 'subscription', product } } : {}),
  } as unknown as ProviderView;
}

function detection(providerId: string, over: Partial<LocalCliDetection> = {}): LocalCliDetection {
  return {
    cli: providerId === 'openai' ? 'codex-cli' : 'claude-cli',
    providerId,
    installed: true,
    loggedIn: true,
    // 默认「确实是同一份凭证」；不共用的场景由用例显式覆写（见 sharedWithCindy 用例）。
    sharedWithCindy: true,
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  navigate.mockClear();
  h.scanCalls = 0;
  h.loading = false;
  const storage = new MemLocalStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    ...globalThis.window,
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: {
      maker: {
        scanLocalCli: vi.fn(async () => {
          h.scanCalls += 1;
          return { detections: h.detections };
        }),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderNotice(enabled = true): Promise<void> {
  const { InheritedSubscriptionNotice } = await import(
    '@/components/onboarding/InheritedSubscriptionNotice'
  );
  await act(async () => {
    render(<InheritedSubscriptionNotice enabled={enabled} />);
  });
}

describe('InheritedSubscriptionNotice', () => {
  it('本机已登录 + 该供应商已连接 → 告知出现，标题用订阅产品名', async () => {
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai')];
    await renderNotice();

    const notice = screen.getByTestId('inherited-subscription-notice');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('ChatGPT');
  });

  it('本机没登录过 → 不出现（那是「去连接」引导的事）', async () => {
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai', { loggedIn: false })];
    await renderNotice();

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('检测到但该供应商未连接 → 不出现，判定与引导卡在 connected 上互补', async () => {
    // 未连接的那些归 useProviderOnboarding.detectedRows 去引导授权；两处都出会重复叙事。
    h.providers = [provider('openai', false, 'ChatGPT')];
    h.detections = [detection('openai')];
    await renderNotice();

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('本机已登录但 Cindy 用的是另一份凭证 → 不出现（否则是错话）', async () => {
    // 回归 PR #1076 review：本机 codex 登录着账号 A、用户又在 Cindy 里显式登录了账号 B 时，
    // installed/loggedIn/connected 三个都为真，但 reconcile 检测到账号不同、刻意让两份凭证
    // 各管各。此时说「已沿用本机订阅」，用户会误以为在花账号 A 的额度。
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai', { sharedWithCindy: false })];
    await renderNotice();

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('device-link 草稿（enabled=false）不出现，也不去扫本机', async () => {
    // 连接态在被控端，本机的检测结果与它无关，提示会指错对象。
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai')];
    await renderNotice(false);

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
    expect(h.scanCalls).toBe(0);
  });

  it('点「知道了」后写入已读，重新挂载不再出现', async () => {
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai')];
    await renderNotice();

    const ack = screen.getByText('onboarding.inheritedSubscription.acknowledge');
    await act(async () => {
      ack.click();
    });
    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();

    // 冷启动重来（同一份 localStorage）→ 一次性告知不该回弹。
    cleanup();
    await renderNotice();
    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('「打开模型供应商」同时记已读并导航 —— 否则回到首屏它还在', async () => {
    h.providers = [provider('openai', true, 'ChatGPT')];
    h.detections = [detection('openai')];
    await renderNotice();

    await act(async () => {
      screen.getByText('onboarding.inheritedSubscription.openProviders').click();
    });
    expect(navigate).toHaveBeenCalledWith('/settings?tab=providers');

    cleanup();
    await renderNotice();
    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('同时继承两家时并列展示，且一次点掉两条', async () => {
    h.providers = [
      provider('anthropic', true, 'Claude.ai'),
      provider('openai', true, 'ChatGPT'),
    ];
    h.detections = [detection('anthropic'), detection('openai')];
    await renderNotice();

    const notice = screen.getByTestId('inherited-subscription-notice');
    expect(notice.textContent).toContain('Claude.ai');
    expect(notice.textContent).toContain('ChatGPT');

    await act(async () => {
      screen.getByText('onboarding.inheritedSubscription.acknowledge').click();
    });
    cleanup();
    await renderNotice();
    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });

  it('已读一家后另一家仍会告知（按 provider 分别记账）', async () => {
    const { acknowledgeInheritedSubscriptions } = await import(
      '@/state/inheritedSubscriptionNotice'
    );
    acknowledgeInheritedSubscriptions(['openai']);

    h.providers = [
      provider('anthropic', true, 'Claude.ai'),
      provider('openai', true, 'ChatGPT'),
    ];
    h.detections = [detection('anthropic'), detection('openai')];
    await renderNotice();

    const notice = screen.getByTestId('inherited-subscription-notice');
    expect(notice.textContent).toContain('Claude.ai');
    expect(notice.textContent).not.toContain('ChatGPT');
  });

  it('供应商清单仍在加载时不扫本机、不闪提示', async () => {
    h.loading = true;
    h.providers = [];
    h.detections = [detection('openai')];
    await renderNotice();

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
    expect(h.scanCalls).toBe(0);
  });

  it('扫描失败静默降级，不挡住首屏', async () => {
    h.providers = [provider('openai', true, 'ChatGPT')];
    (window as unknown as {
      electronAPI: { maker: { scanLocalCli: () => Promise<unknown> } };
    }).electronAPI.maker.scanLocalCli = vi.fn(async () => {
      throw new Error('scan failed');
    });
    await renderNotice();

    expect(screen.queryByTestId('inherited-subscription-notice')).toBeNull();
  });
});
