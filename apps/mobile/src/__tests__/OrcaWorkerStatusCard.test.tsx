// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listOrcaWorkersByLead: vi.fn(),
  connectionEpoch: 0,
  peerAvailable: true as boolean | null,
  linkStatus: 'online' as string,
  colors: {
    surface: 'SURFACE',
    surfaceElevated: 'SURFACE_ELEVATED',
    border: 'BORDER',
    textPrimary: 'TEXT_PRIMARY',
    textSecondary: 'TEXT_SECONDARY',
    textTertiary: 'TEXT_TERTIARY',
    statusAccent: 'ACCENT',
    statusDone: 'DONE',
    statusError: 'ERROR',
  },
}));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  ScrollView: ({ children }: any) => createElement('div', {}, children),
  View: ({ children, style, testID }: any) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }, children),
  Pressable: ({ children, onPress, testID }: any) =>
    createElement(
      'button',
      { onClick: onPress, 'data-testid': testID },
      typeof children === 'function' ? children({ pressed: false }) : children,
    ),
  StyleSheet: { create: (v: any) => v, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => useEffect(cb, [cb]) }));
vi.mock('lucide-react-native', () => ({
  ChevronDown: () => createElement('i', { 'data-icon': 'down' }),
  ChevronRight: () => createElement('i', { 'data-icon': 'right' }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => createElement('span', {}, children),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: h.colors }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({
    status: h.linkStatus,
    connectionEpoch: h.connectionEpoch,
    getPresenceAvailability: () => h.peerAvailable,
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/theme/tokens', () => ({
  fontWeight: { semibold: '600' },
  iconSize: { sm: 8, md: 16 },
  iconStroke: { regular: 2 },
  lineHeight: { listBody: 20 },
  radius: { container: 12, micro: 3, pill: 9999 },
  typeScale: { body: 14, caption: 12 },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { OrcaWorkerStatusCard } = await import('@/session/OrcaWorkerStatusCard');
// 登录身份走真实的 authOwnerGeneration(卡片通过 useSyncExternalStore 订阅它),
// 测到的就是生产中的身份发布路径,而不是一个自造的 prop。
const authOwner = await import('@/auth/authOwnerGeneration');

/** 切换登录身份。setMobileAuthOwner 会同步通知订阅者,必须包在 act 里。 */
async function signIn(accountId: string | null, realm: 'global' | 'cn' = 'global') {
  await act(async () => { authOwner.setMobileAuthOwner(accountId, realm); });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.listOrcaWorkersByLead.mockReset();
  authOwner.__testing.reset();
  authOwner.setMobileAuthOwner('acct-1');
  h.connectionEpoch = 0;
  h.peerAvailable = true;
  h.linkStatus = 'online';
  leadSeq += 1;
  lead = `lead-${leadSeq}`;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

// 未读是 module 级 store(契约要求跨组件切换存活),因此每个用例必须用各自的
// leadSessionId,否则会互相串味。
let leadSeq = 0;
let lead = 'lead-0';

async function render(workers: unknown[], onOpenWorker?: (id: string) => boolean) {
  h.listOrcaWorkersByLead.mockResolvedValue(workers);
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
        onOpenWorker,
      }),
    );
  });
}

/** 现实中 useMobileMakerTransport 在换号/重连时保持同一身份,测试必须复用同一对象。 */
const stableMaker = { listOrcaWorkersByLead: (...a: unknown[]) => h.listOrcaWorkersByLead(...a) } as any;

const attentionDot = () => container.querySelector('[data-testid="session.orcaWorkers.attention"]');
const toggle = () =>
  container.querySelector('[data-testid="session.orcaWorkers.toggle"]') as HTMLButtonElement;

function backgroundColorOf(el: Element | null | undefined): string | undefined {
  const raw = el?.getAttribute('data-style');
  if (!raw) return undefined;
  return [JSON.parse(raw)].flat(Infinity).find((s: any) => s?.backgroundColor)?.backgroundColor;
}

function dotColorOf(name: string): string | undefined {
  const row = [...container.querySelectorAll('button, div')]
    .filter((el) => el.textContent?.startsWith(name))
    .pop();
  return backgroundColorOf(row?.querySelector('div[data-style]'));
}

it('拿到非空快照前不渲染,避免在测量区里先撑开再收起', async () => {
  h.listOrcaWorkersByLead.mockReturnValue(new Promise(() => {}));
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: 'lead-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  expect(container.innerHTML).toBe('');
});

it('空团队不渲染', async () => {
  await render([]);
  expect(container.innerHTML).toBe('');
});

it('状态点按语义分流:idle 走中性色,不与运行中撞色', async () => {
  await render([
    { id: 'a', label: 'w-idle', status: 'idle', sessionId: 's-a' },
    { id: 'b', label: 'w-running', status: 'running', sessionId: 's-b' },
    { id: 'c', label: 'w-done', status: 'done', sessionId: 's-c' },
    { id: 'd', label: 'w-error', status: 'error', sessionId: 's-d' },
    { id: 'e', label: 'w-unknown', sessionId: 's-e' },
  ]);
  await act(async () => toggle().click());
  expect(dotColorOf('w-idle')).toBe('TEXT_TERTIARY');
  expect(dotColorOf('w-running')).toBe('ACCENT');
  expect(dotColorOf('w-done')).toBe('DONE');
  expect(dotColorOf('w-error')).toBe('ERROR');
  expect(dotColorOf('w-unknown')).toBe('TEXT_TERTIARY');
});

it('idle 不提示,跳变进 done 才提示', async () => {
  vi.useFakeTimers();
  await render([{ id: 'a', label: 'w', status: 'idle', sessionId: 's-a' }]);
  expect(attentionDot()).toBeNull();

  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'done', sessionId: 's-a' },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(attentionDot()).not.toBeNull();
});

it('打开 Worker 即视为已查看,提示随之清除', async () => {
  const onOpenWorker = vi.fn(() => true);
  await render([{ id: 'a', label: 'w-done', status: 'done', sessionId: 's-a' }], onOpenWorker);
  expect(attentionDot()).not.toBeNull();

  await act(async () => toggle().click());
  const row = container.querySelector(
    '[data-testid="session.orcaWorkers.worker.s-a"]',
  ) as HTMLButtonElement;
  await act(async () => row.click());
  expect(onOpenWorker).toHaveBeenCalledWith('s-a');

  // 收起后不应再提示:已查看过这个 done。
  await act(async () => toggle().click());
  expect(attentionDot()).toBeNull();
});

async function viewWorker() {
  await act(async () => toggle().click());
  await act(async () => {
    (container.querySelector(
      '[data-testid="session.orcaWorkers.worker.s-a"]',
    ) as HTMLButtonElement).click();
  });
  await act(async () => toggle().click());
}

it('done → running → done 属于两次跳变,第二轮完成必须重新提示', async () => {
  vi.useFakeTimers();
  await render([{ id: 'a', label: 'w', status: 'done', sessionId: 's-a' }], vi.fn(() => true));
  await viewWorker();
  expect(attentionDot()).toBeNull();

  // 离开终态。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'running', sessionId: 's-a' },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(attentionDot()).toBeNull();

  // 再次进入 done:新的一轮,必须重新提示,不能被上一轮的已查看吞掉。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'done', sessionId: 's-a' },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(attentionDot()).not.toBeNull();
});

it('切走再切回不得让同一轮 done 重新变未读(orca-team-architecture.md:324)', async () => {
  vi.useFakeTimers();
  const workers = [{ id: 'a', label: 'w', status: 'done', sessionId: 's-a' }];
  await render(workers, vi.fn(() => true));
  await viewWorker();
  expect(attentionDot()).toBeNull();

  // 整个组件卸载重建 = 离开会话页再回来;状态未变,不应产生新边沿。
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render(workers, vi.fn(() => true));
  expect(attentionDot()).toBeNull();
});

it('导航被丢弃时不得把该 Worker 记为已查看', async () => {
  // guardedPush 在失焦 / 前进锁命中时静默丢弃,回调返回 false。
  const rejected = vi.fn(() => false);
  await render([{ id: 'a', label: 'w-done', status: 'done', sessionId: 's-a' }], rejected);
  expect(attentionDot()).not.toBeNull();

  await act(async () => toggle().click());
  await act(async () => {
    (container.querySelector(
      '[data-testid="session.orcaWorkers.worker.s-a"]',
    ) as HTMLButtonElement).click();
  });
  expect(rejected).toHaveBeenCalledWith('s-a');

  // 没真正打开 → 收起后仍应提示。
  await act(async () => toggle().click());
  expect(attentionDot()).not.toBeNull();
});

it('换 Lead 后不得闪出上一个 Lead 的列表', async () => {
  await render([{ id: 'a', label: 'w-from-A', status: 'running', sessionId: 's-a' }]);
  await act(async () => toggle().click()); // 默认折叠,展开才渲染行
  expect(container.textContent).toContain('w-from-A');

  // 就地换 Lead(组件不卸载):B 的首帧必须已经看不到 A 的数据。
  h.listOrcaWorkersByLead.mockReturnValue(new Promise(() => {}));
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: `${lead}-B`,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  expect(container.textContent ?? '').not.toContain('w-from-A');
});

it('CHANNEL_NOT_ALLOWED 是永久兼容结果:只探一次即停轮询', async () => {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockRejectedValue(
    Object.assign(new Error('remote invoke failed'), { code: 'CHANNEL_NOT_ALLOWED' }),
  );
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).toBe('');

  // 再过几轮也不得重发:面板保持不显示。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1);
});

it('瞬时失败仍继续轮询,并在恢复后显示', async () => {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockRejectedValue(new Error('tunnel dropped'));
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1);

  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-back', status: 'running', sessionId: 's-a' },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(h.listOrcaWorkersByLead.mock.calls.length).toBeGreaterThan(1);
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-back');
});

it('不支持通道时清掉旧快照,面板不再显示陈旧数据', async () => {
  vi.useFakeTimers();
  // 先成功拿到一份快照。
  await render([{ id: 'a', label: 'w-stale', status: 'running', sessionId: 's-a' }]);
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-stale');

  // 设备被旧版实例接管:下一轮返回 CHANNEL_NOT_ALLOWED。
  h.listOrcaWorkersByLead.mockRejectedValue(
    Object.assign(new Error('rejected'), { code: 'CHANNEL_NOT_ALLOWED' }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(container.innerHTML).toBe('');
});

it('device-link 重连(connectionEpoch 变化)后重新探测通道', async () => {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockRejectedValue(
    Object.assign(new Error('rejected'), { code: 'CHANNEL_NOT_ALLOWED' }),
  );
  const render1 = () => root.render(
    createElement(OrcaWorkerStatusCard as any, {
      leadSessionId: lead,
      deviceId: 'dev-1',
      maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
    }),
  );
  await act(async () => { render1(); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1); // 已停轮询

  // 被控端升级后重连:同一 maker 身份,但连接代次前进 → 必须重探。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-after-reconnect', status: 'running', sessionId: 's-a' },
  ]);
  h.connectionEpoch = 1;
  await act(async () => { render1(); });
  expect(h.listOrcaWorkersByLead.mock.calls.length).toBeGreaterThan(1);
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-after-reconnect');
});

it('仅被控端重启(connectionEpoch 不变)也必须重探通道', async () => {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockRejectedValue(
    Object.assign(new Error('rejected'), { code: 'CHANNEL_NOT_ALLOWED' }),
  );
  const draw = () => root.render(
    createElement(OrcaWorkerStatusCard as any, {
      leadSessionId: lead,
      deviceId: 'dev-1',
      maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
    }),
  );
  await act(async () => { draw(); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalledTimes(1); // 已停轮询

  // 被控端升级重启:只有该 peer 掉线再上线,controller 未重连 relay。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-peer-back', status: 'running', sessionId: 's-a' },
  ]);
  h.peerAvailable = false;
  await act(async () => { draw(); });
  h.peerAvailable = true;
  await act(async () => { draw(); });

  expect(h.connectionEpoch).toBe(0); // 关键:整代未变
  expect(h.listOrcaWorkersByLead.mock.calls.length).toBeGreaterThan(1);
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-peer-back');
});

it('peer 确定离线时暂停轮询,不再每 5 秒撞 DEVICE_OFFLINE', async () => {
  vi.useFakeTimers();
  h.peerAvailable = false;
  h.listOrcaWorkersByLead.mockRejectedValue(
    Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' }),
  );
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(h.listOrcaWorkersByLead).not.toHaveBeenCalled();
});

it('peer 回到在线后恢复轮询', async () => {
  vi.useFakeTimers();
  h.peerAvailable = false;
  const draw = () => root.render(
    createElement(OrcaWorkerStatusCard as any, {
      leadSessionId: lead,
      deviceId: 'dev-1',
      maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
    }),
  );
  await act(async () => { draw(); });
  expect(h.listOrcaWorkersByLead).not.toHaveBeenCalled();

  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-online', status: 'running', sessionId: 's-a' },
  ]);
  h.peerAvailable = true;
  await act(async () => { draw(); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalled();
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-online');
});

it('availability 未决(null)不阻断探测', async () => {
  h.peerAvailable = null;
  await render([{ id: 'a', label: 'w-null', status: 'running', sessionId: 's-a' }]);
  expect(h.listOrcaWorkersByLead).toHaveBeenCalled();
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-null');
});

it('label 与 role 都缺失时,兜底名走 i18n catalog 而非硬编码', async () => {
  await render([{ id: 'a', status: 'running', sessionId: 's-a' }]);
  await act(async () => toggle().click());
  // mock 的 i18n.t 直接回 key:命中说明走了 catalog,没有硬编码 "Worker 1"。
  expect(container.textContent).toContain(
    'session.presentation.collaboration.workerFallbackName',
  );
  expect(container.textContent).not.toContain('Worker 1');
});

it('relay 掉线时暂停轮询,即便逐设备 availability 仍停在 true', async () => {
  vi.useFakeTimers();
  // 正是 review 描述的场景:上一代的 per-peer verdict 还是 true,但 relay 已不在线。
  h.peerAvailable = true;
  h.linkStatus = 'connecting';
  h.listOrcaWorkersByLead.mockRejectedValue(new Error('should not be called'));
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(h.listOrcaWorkersByLead).not.toHaveBeenCalled();
});

it('relay 恢复在线后继续轮询', async () => {
  vi.useFakeTimers();
  h.linkStatus = 'connecting';
  const draw = () => root.render(
    createElement(OrcaWorkerStatusCard as any, {
      leadSessionId: lead,
      deviceId: 'dev-1',
      maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
    }),
  );
  await act(async () => { draw(); });
  expect(h.listOrcaWorkersByLead).not.toHaveBeenCalled();

  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-relay-back', status: 'running', sessionId: 's-a' },
  ]);
  h.linkStatus = 'online';
  await act(async () => { draw(); });
  expect(h.listOrcaWorkersByLead).toHaveBeenCalled();
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-relay-back');
});

it('error 未读在 worker 转回 running 后仍显示错误色,不退化成绿色 Done', async () => {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'error', sessionId: 's-a' },
  ]);
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  expect(backgroundColorOf(attentionDot())).toBe('ERROR');

  // worker 重新跑起来:未读仍在(结果没被看过),提示色必须仍来自 error。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'running', sessionId: 's-a' },
  ]);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(attentionDot()).not.toBeNull();
  expect(backgroundColorOf(attentionDot())).toBe('ERROR');
});

it('卡片使用抬层背景 surfaceElevated,而非页面级 surface', async () => {
  await render([{ id: 'a', label: 'w', status: 'running', sessionId: 's-a' }]);
  const card = container.querySelector('div[data-style]');
  expect(backgroundColorOf(card)).toBe('SURFACE_ELEVATED');
});

async function mountAndAdvance(statuses: string[]) {
  vi.useFakeTimers();
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: statuses[0], sessionId: 's-a' },
  ]);
  await act(async () => {
    root.render(
      createElement(OrcaWorkerStatusCard as any, {
        leadSessionId: lead,
        deviceId: 'dev-1',
        maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
      }),
    );
  });
  for (const status of statuses.slice(1)) {
    h.listOrcaWorkersByLead.mockResolvedValue([
      { id: 'a', label: 'w', status, sessionId: 's-a' },
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  }
}

it('未读 done 的 worker 复用后转 error:提示升级为错误色', async () => {
  // done 未读 → 被复用跑起来 → 再次失败。全程未查看。
  await mountAndAdvance(['done', 'running', 'error']);
  expect(attentionDot()).not.toBeNull();
  expect(backgroundColorOf(attentionDot())).toBe('ERROR');
});

it('未读 error 之后转 done:不降级,失败不被后来的成功掩盖', async () => {
  await mountAndAdvance(['error', 'running', 'done']);
  expect(attentionDot()).not.toBeNull();
  expect(backgroundColorOf(attentionDot())).toBe('ERROR');
});

it('未读与已读按账号隔离:换账号不得继承上一个账号的状态', async () => {
  vi.useFakeTimers();
  const workers = [{ id: 'a', label: 'w', status: 'done', sessionId: 's-a' }];
  h.listOrcaWorkersByLead.mockResolvedValue(workers);
  const mount = async (accountScope: string) => {
    await signIn(accountScope);
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId: 'dev-1',
          maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
          onOpenWorker: () => true,
        }),
      );
    });
  };

  // 账号 A:done 产生未读,查看后清除。
  await mount('acct-A');
  expect(attentionDot()).not.toBeNull();
  await act(async () => toggle().click());
  await act(async () => {
    (container.querySelector(
      '[data-testid="session.orcaWorkers.worker.s-a"]',
    ) as HTMLButtonElement).click();
  });
  await act(async () => toggle().click());
  expect(attentionDot()).toBeNull();

  // 换到账号 B:同样的 Lead / Worker id,但不得继承 A 的「已查看」。
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await mount('acct-B');
  expect(attentionDot()).not.toBeNull();
});

it('快照绑定账号与设备:换号或换设备后旧列表立刻失效,不渲染', async () => {
  vi.useFakeTimers();
  const render1 = async (accountScope: string, deviceId: string) => {
    await signIn(accountScope);
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId,
          maker: { listOrcaWorkersByLead: h.listOrcaWorkersByLead } as any,
          onOpenWorker: () => true,
        }),
      );
    });
  };
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-A', status: 'running', sessionId: 's-a' },
  ]);
  await render1('acct-A', 'dev-1');
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-A');

  // 换账号:同一 Lead / 同一设备,但快照属于上一个账号 —— 首帧就必须失效。
  h.listOrcaWorkersByLead.mockReturnValue(new Promise(() => {}));
  await render1('acct-B', 'dev-1');
  expect(container.innerHTML).toBe('');

  // 换设备同理:同一 Lead id 在另一台被控机上不是同一份东西。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-A', status: 'running', sessionId: 's-a' },
  ]);
  await render1('acct-B', 'dev-1');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  h.listOrcaWorkersByLead.mockReturnValue(new Promise(() => {}));
  await render1('acct-B', 'dev-2');
  expect(container.innerHTML).toBe('');
});

it('换号时在飞的旧响应不得污染新账号的未读', async () => {
  vi.useFakeTimers();
  const mount = async (accountScope: string) => {
    await signIn(accountScope);
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId: 'dev-1',
          maker: stableMaker,
          onOpenWorker: () => true,
        }),
      );
    });
  };

  // 账号 A 的第一轮请求悬停,让它在换号之后才落地。
  let settleOld: ((v: unknown) => void) | undefined;
  h.listOrcaWorkersByLead.mockReturnValue(new Promise((r) => { settleOld = r; }));
  await mount('acct-A');

  // 换到账号 B:store 在渲染期被重置,B 自己先看到 running。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'running', sessionId: 's-a' },
  ]);
  await mount('acct-B');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });

  // 账号 A 的响应此刻才落地,带着一个 done —— 不得给账号 B 造出未读,
  // 也不得把 lastStatus 写成 done(那会吞掉 B 后续 running → done 的边沿)。
  await act(async () => {
    settleOld?.([{ id: 'a', label: 'w', status: 'done', sessionId: 's-a' }]);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(attentionDot()).toBeNull();

  // B 自己的 running → done 必须照常产生未读。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'done', sessionId: 's-a' },
  ]);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(attentionDot()).not.toBeNull();
});

it('换号后轮询重启,卡片能显示新账号的数据', async () => {
  vi.useFakeTimers();
  const mount = async (accountScope: string) => {
    await signIn(accountScope);
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId: 'dev-1',
          maker: stableMaker,
          onOpenWorker: () => true,
        }),
      );
    });
  };
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w-A', status: 'running', sessionId: 's-a' },
  ]);
  await mount('acct-A');
  await act(async () => toggle().click());
  expect(container.textContent).toContain('w-A');

  // 换号:effect 依赖含作用域,必须重启并用新账号身份写快照,否则卡片永远空白。
  // expanded 不随换号重置,这里不再 toggle。
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'b', label: 'w-B', status: 'running', sessionId: 's-b' },
  ]);
  await mount('acct-B');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(container.textContent).toContain('w-B');
  expect(container.textContent).not.toContain('w-A');
});

// 围栏直测:组件路径下 act() 会把渲染与 passive cleanup 压在一起,复现不出
// 「reset 已执行、cleanup 未执行」的窗口,故直接驱动 store 函数。
it('在飞响应的身份围栏:reset 之后落地的旧身份响应被整体丢弃', async () => {
  const { workerAttentionOwnerScope, resetWorkerAttentionScope, applyWorkerAttentionEdges } =
    await import('@/session/OrcaWorkerStatusCard');
  const ownerA = workerAttentionOwnerScope({ accountId: 'a', accountKey: 'ka', generation: 1 });
  const ownerB = workerAttentionOwnerScope({ accountId: 'b', accountKey: 'kb', generation: 2 });
  const done = [{ id: 'a', status: 'done', sessionId: 's-a' }];

  resetWorkerAttentionScope(ownerA);
  expect(applyWorkerAttentionEdges(ownerA, 'dev-1', 'lead-x', done)).toBe(true);

  // 换号:store 被重置为 B。此刻账号 A 的在飞响应才落地。
  resetWorkerAttentionScope(ownerB);
  expect(applyWorkerAttentionEdges(ownerA, 'dev-1', 'lead-x', done)).toBe(false);

  // B 自己观测到同一个 worker 的 done,仍应是一次全新的边沿(未被 A 的数据污染)。
  expect(applyWorkerAttentionEdges(ownerB, 'dev-1', 'lead-x', done)).toBe(true);
});

it('登录身份按 realm 限定 key + generation 区分:同 membership id 不得视为同一身份', () => {
  const g = (accountId: string, realm: 'global' | 'cn') => {
    authOwner.setMobileAuthOwner(accountId, realm);
    return authOwner.getMobileAuthOwner();
  };
  return import('@/session/OrcaWorkerStatusCard').then(({ workerAttentionOwnerScope }) => {
    authOwner.__testing.reset();
    const first = workerAttentionOwnerScope(g('u1', 'global'));
    // 跨 realm 同 id:realm 限定的 accountKey 不同。
    const otherRealm = workerAttentionOwnerScope(g('u1', 'cn'));
    expect(otherRealm).not.toBe(first);
    // 同 realm 同 id 重新登录(中间经过登出):generation 前进,仍是新身份。
    authOwner.setMobileAuthOwner(null);
    const relogin = workerAttentionOwnerScope(g('u1', 'global'));
    expect(relogin).not.toBe(first);
  });
});

// 组件级只能覆盖「跨 realm 同 id 直接切换」:登出→登入会经过一次空身份,裸 id 作用域
// 也会变化,effect 随之重启,测不出差异;而「旧代次在飞响应被接受」只发生在 passive
// cleanup 窗口,由上面的身份围栏直测覆盖。
it('跨 realm 同 membership id 切换:上一 realm 的已读不得被新身份接受', async () => {
  vi.useFakeTimers();
  const mount = async () => {
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId: 'dev-1',
          maker: stableMaker,
          onOpenWorker: () => true,
        }),
      );
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'done', sessionId: 's-a' },
  ]);
  await signIn('u1', 'global');
  await mount();
  await viewWorker();
  expect(attentionDot()).toBeNull();

  // 同一 membership id 直接切到另一个 realm:setMobileAuthOwner 不经过空身份,
  // 裸 id 不变。它是另一个登录身份,global 下的「已查看」不能带过来。
  await signIn('u1', 'cn');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(attentionDot()).not.toBeNull();
});

it('跨设备切走再切回:同一登录身份下已读的完成不得复活为未读', async () => {
  vi.useFakeTimers();
  const mountOn = async (deviceId: string) => {
    await act(async () => {
      root.render(
        createElement(OrcaWorkerStatusCard as any, {
          leadSessionId: lead,
          deviceId,
          maker: stableMaker,
          onOpenWorker: () => true,
        }),
      );
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  h.listOrcaWorkersByLead.mockResolvedValue([
    { id: 'a', label: 'w', status: 'done', sessionId: 's-a' },
  ]);

  // 设备 A:done 产生未读,查看后清除。
  await mountOn('dev-A');
  expect(attentionDot()).not.toBeNull();
  await viewWorker();
  expect(attentionDot()).toBeNull();

  // 切到设备 B:另一台机器上的同名 worker 是独立的,照常提示。
  await mountOn('dev-B');
  expect(attentionDot()).not.toBeNull();

  // 切回设备 A,worker 仍是 done:同一轮 done,不得重新变未读。
  await mountOn('dev-A');
  expect(attentionDot()).toBeNull();
});

it('状态点与提示点都是圆形(pill 半径),与共享 StatusDot 几何一致', async () => {
  vi.useFakeTimers();
  await render([{ id: 'a', label: 'w-done', status: 'done', sessionId: 's-a' }], () => true);
  const radiusOf = (el: Element | null | undefined) => {
    const raw = el?.getAttribute('data-style');
    return raw ? [JSON.parse(raw)].flat(Infinity).find((s: any) => s?.borderRadius !== undefined)?.borderRadius : undefined;
  };
  // 折叠态提示点。
  expect(radiusOf(attentionDot())).toBe(9999);
  // 展开后的行内状态点。
  await act(async () => toggle().click());
  const row = container.querySelector('[data-testid="session.orcaWorkers.worker.s-a"]');
  expect(radiusOf(row?.querySelector('div[data-style]'))).toBe(9999);
});
