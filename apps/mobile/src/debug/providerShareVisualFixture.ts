/**
 * 「我分享的供应商」的界面模拟数据(docs/dev-rules/ui-mock-data.md)：模拟电脑上一个建了供应商组、已分享给几个人的
 * Anthropic，带一条待处理申请。只在 `--mock` 且另加 `EXPO_PUBLIC_CINDY_PROVIDER_SHARE_DEMO=1` 时启用，
 * 平时的模拟场景不变(模型列表仍是没有供应商目录的那一套)。
 *
 * 全是合成数据，只存在本次进程的内存里：生成的链接打不开，同意、拒绝不会通知任何人。
 * 回包结构与供应商所在电脑的真实回包相同，页面仍走生产的解析与读取节奏。
 */
const ENABLED = typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_CINDY_PROVIDER_SHARE_DEMO === '1';

const PROVIDER_ID = 'anthropic';
const LINK_ID = 'f'.repeat(64);
/** 生成链接后过这么久出现它带来的申请，演示「留在这一页等申请」。 */
const DEMO_REQUEST_DELAY_MS = 8_000;

interface DemoPerson { displayName: string; avatarUrl: null; region: 'global' }
const person = (displayName: string): DemoPerson => ({ displayName, avatarUrl: null, region: 'global' });

let members = [
  { ...person('Abu'), memberId: 'demo-member-abu', status: 'active', joinedAt: '2026-11-02T03:00:00.000Z', note: null, runningTasks: 2 },
  { ...person('Dash'), memberId: 'demo-member-dash', status: 'active', joinedAt: '2026-11-08T09:30:00.000Z', note: '设计组', runningTasks: 0 },
  { ...person('LiZi'), memberId: 'demo-member-lizi', status: 'paused', joinedAt: '2026-11-15T12:00:00.000Z', note: null, runningTasks: 0 },
];
interface DemoRequest extends DemoPerson { requestId: string; linkId?: string; pairingCode: string; createdAt: string; expiresAt: string }
let requests: DemoRequest[] = [
  { ...person('小满'), requestId: 'demo-request-pending', pairingCode: '4821', createdAt: new Date(Date.now() - 3 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
];
let linkRequestAt = 0;

function pendingRequests() {
  if (linkRequestAt > 0 && Date.now() >= linkRequestAt) {
    linkRequestAt = 0;
    requests = [...requests, {
      ...person('团团'), requestId: `demo-request-${Date.now()}`, linkId: LINK_ID, pairingCode: '0937',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }];
  }
  return requests;
}

const groupMembers = [
  { key: 'local', kind: 'local', agentDeviceId: null, providerId: PROVIDER_ID, label: 'Mac Studio', state: 'full', running: 6 },
  { key: 'device:demo-macbook:anthropic', kind: 'device', agentDeviceId: 'demo-macbook', providerId: PROVIDER_ID, label: 'MacBook Pro', state: 'available', running: 3 },
  { key: 'device:demo-mini:anthropic', kind: 'device', agentDeviceId: 'demo-mini', providerId: PROVIDER_ID, label: 'Mac mini', state: 'cooling', running: 0,
    usageLimit: { resetAtMs: Date.now() + 26 * 3_600_000 } },
  { key: 'share:demo-share:anthropic', kind: 'share', agentDeviceId: 'share:demo-share', providerId: PROVIDER_ID, label: 'Shared computer', state: 'available', running: 1,
    ownerName: 'Taylor' },
];

function quota(deviceId: string) {
  const window = (kind: 'session' | 'week', remainingPercent: number, hours: number, windowMinutes: number) => ({
    kind, label: null, remainingPercent, resetsAt: Date.now() + hours * 3_600_000, windowMinutes,
  });
  const account = (session: number, week: number) => ({
    state: 'ready', updatedAt: Date.now(), balance: null,
    windows: [window('session', session, 2.5, 300), window('week', week, 74, 10_080)],
  });
  if (deviceId === 'demo-mini') return account(0, 6);
  if (deviceId === 'demo-macbook') return { ...account(64, 41), accounts: [account(64, 41), account(88, 23)] };
  return account(18, 72);
}

/** 模拟电脑目录里的供应商；未启用演示时为空(与原有模拟场景一致)。 */
export function providerShareVisualProviders(): unknown[] {
  if (!ENABLED) return [];
  return [{
    id: PROVIDER_ID,
    name: 'Anthropic',
    source: 'builtin',
    agents: ['claude-code'],
    models: [],
    auth: { method: 'oauth' },
    connected: true,
    remoteInvocationEnabled: true,
    group: { strategy: 'least', autoSwitch: true, members: groupMembers.map(({ key, kind, agentDeviceId, providerId }) => ({ key, kind, agentDeviceId, providerId, limit: 6, weight: 1, paused: false })) },
  }];
}

/** `provider-group:remote` 的分享管理与组视图；不是这两类请求或未启用演示时返回 undefined，由调用方照旧处理。 */
export function providerShareVisualInvoke(deviceId: string, raw: unknown): unknown | undefined {
  if (!ENABLED || !raw || typeof raw !== 'object') return undefined;
  const request = raw as { action?: string; providerId?: string; command?: { action?: string; providerId?: string; requestId?: string } };
  if (request.action === 'view') {
    return {
      providerId: request.providerId,
      config: { strategy: 'least', autoSwitch: true, members: groupMembers.map(({ key, kind, agentDeviceId, providerId }) => ({ key, kind, agentDeviceId, providerId, limit: 6, weight: 1, paused: false })) },
      members: groupMembers.map(({ agentDeviceId: _agent, providerId: _provider, ...status }) => ({ ...status, limit: 6, limitSet: true, weight: 1, paused: false })),
    };
  }
  if (request.action !== 'manage-share' || !request.command) return undefined;
  const command = request.command;
  const reply = (result: unknown) => ({ result, respondedAt: Date.now() });
  switch (command.action) {
    case 'owned':
      return reply({
        ready: true,
        includeUsage: false,
        shares: [{ shareId: 'demo-share-anthropic', providerId: PROVIDER_ID, providerLabel: 'Anthropic', createdAt: '2026-11-01T00:00:00.000Z', members, requests: pendingRequests() }],
      });
    case 'quota-account':
      return reply(quota(deviceId));
    case 'create-link':
      linkRequestAt = Date.now() + DEMO_REQUEST_DELAY_MS;
      return reply({ link: 'https://cindy.example.invalid/provider-share#demo-link-not-usable', linkId: LINK_ID, expiresAt: new Date(Date.now() + 295_000).toISOString() });
    case 'approve':
    case 'reject': {
      const target = requests.find((entry) => entry.requestId === command.requestId);
      if (!target) throw new Error('[NOT_FOUND] The share request or member is no longer on this computer');
      requests = requests.filter((entry) => entry !== target);
      if (command.action === 'approve') {
        members = [...members, { ...person(target.displayName), memberId: `demo-member-${target.requestId}`, status: 'active', joinedAt: new Date().toISOString(), note: null, runningTasks: 0 }];
      }
      return reply({ ok: true });
    }
    default:
      throw new Error('[INVALID_PARAMS] Unknown command');
  }
}
