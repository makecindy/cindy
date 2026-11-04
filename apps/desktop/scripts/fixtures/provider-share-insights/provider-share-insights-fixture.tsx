import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { ProviderShareManagePage } from '../../../src/renderer/features/provider-share/ProviderShareManagePage';
import { ProviderShareReceivedDetail } from '../../../src/renderer/features/provider-share/ProviderShareReceivedRail';
import type {
  ProviderShareInsights,
  ProviderShareQuotaAccount,
} from '../../../src/shared/providerShareInsights';
import type { ProviderShareReceived } from '@cindy/device-link';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimitsView } from '../../../src/shared/remoteAgentLimits';

const now = Date.parse('2026-10-19T12:00:00Z');
const share: ProviderShareReceived = {
  shareId: 'fixture-share',
  memberId: 'fixture-member',
  providerId: 'xd',
  providerLabel: 'Cindy AI',
  hostDeviceId: 'fixture-host',
  deviceName: 'Private device name',
  owner: { displayName: '林晓', avatarUrl: null, region: 'global' },
  status: 'active',
  hostOnline: true,
  hostCapable: true,
};
const days = (model: string, tokens: number) =>
  [0, 1, 2, 4, 6, 10, 12, 17, 23].map((offset) => ({
    day: new Date(now - offset * 86_400_000).toISOString().slice(0, 10),
    kind: 'claude-code',
    model,
    turns: 5,
    inputTokens: tokens + offset * 180,
    outputTokens: 3_000,
    cacheReadTokens: 15_000,
    cacheCreateTokens: 1_000,
    amount: { amount: 0.42, currency: 'USD' as const },
  }));
const usage: NonNullable<ProviderShareInsights['usage']> = {
  todayKey: '2026-10-19',
  coverageStart: null,
  parties: [
    {
      key: 'owner',
      displayName: '林晓',
      avatarUrl: null,
      isOwner: true,
      isYou: false,
      isRelay: false,
      lastUsedAt: now,
      days: days('claude-sonnet-4-6', 42_000),
    },
    {
      key: 'member',
      displayName: 'Alex',
      avatarUrl: null,
      isOwner: false,
      isYou: true,
      isRelay: false,
      lastUsedAt: now,
      days: days('claude-opus-4-6', 28_000),
    },
    {
      key: 'relay',
      displayName: '',
      avatarUrl: null,
      isOwner: false,
      isYou: false,
      isRelay: true,
      lastUsedAt: now,
      days: days('claude-sonnet-4-6', 6_000),
    },
  ],
};
const account = {
  state: 'ready' as const,
  updatedAt: now,
  windows: [],
  balance: {
    remaining: 64.8,
    total: 100,
    currency: 'USD' as const,
    resetsAt: null,
    pools: [
      { kind: 'plan' as const, remaining: 24.8, total: 60 },
      { kind: 'purchased' as const, remaining: 30, total: 30 },
      { kind: 'promotional' as const, remaining: 10, total: 10 },
    ],
  },
};
const history = {
  providerId: 'xd',
  todayKey: usage.todayKey,
  coverageStart: null,
  self: {
    lastUsedAt: now,
    days: usage.parties[0].days.map((day) => ({ ...day, providerId: 'xd', memberKey: 'local' })),
  },
  relays: [],
  members: [],
};

void mountPage({
  host: (ctx) => {
    const remainingPercent =
      typeof ctx.data.remainingPercent === 'number' ? ctx.data.remainingPercent : null;
    const quota = ctx.case !== 'closed' && ctx.case !== 'usage-only';
    const allowUsage = ctx.case !== 'closed' && ctx.case !== 'quota-only';
    const subscriptionAccount: ProviderShareQuotaAccount = {
      state: 'ready',
      updatedAt: now,
      balance: null,
      windows: [
        {
          kind: 'session',
          label: null,
          windowMinutes: 300,
          remainingPercent: remainingPercent ?? 43,
          resetsAt: now + 7_200_000,
        },
        {
          kind: 'week',
          label: null,
          windowMinutes: 10080,
          remainingPercent: 72,
          resetsAt: now + 86_400_000,
        },
      ],
    };
    const displayedAccount: ProviderShareQuotaAccount =
      ctx.case === 'subscription'
        ? subscriptionAccount
        : remainingPercent !== null || ['organization', 'unknown', 'zero'].includes(ctx.case)
          ? {
              ...account,
              balance: {
                ...account.balance,
                pools: [],
                remaining: remainingPercent ?? (ctx.case === 'zero' ? 0 : 64.8),
                total: ctx.case === 'unknown' ? null : 100,
              },
            }
          : account;
    let visibility = { quota, usage: allowUsage };
    const command = async (cmd: {
      action: string;
      includeUsage?: boolean;
      visibility?: Partial<typeof visibility>;
      favoriteRecovery?: { ownerStamp: unknown };
    }) => {
      switch (cmd.action) {
        case 'get-model-access':
          return { version: 1, models: null, providerModels: null, availableModels: [
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'gpt-5.5', name: 'GPT-5.5' },
          ] };
        case 'get-visibility':
          return visibility;
        case 'set-visibility':
          visibility = { ...visibility, ...cmd.visibility };
          return visibility; // fixture memory only
        case 'insights':
          return {
            version: 1,
            capabilities: visibility,
            status: {
              quota: quota ? 'ready' : 'disabled',
              usage: !allowUsage ? 'disabled' : cmd.includeUsage ? 'ready' : 'not-requested',
            },
            quota: quota
              ? {
                  group: ctx.case === 'group',
                  partial: ctx.case === 'group',
                  accounts:
                    ctx.case === 'group' ? [account, subscriptionAccount] : [displayedAccount],
                }
              : null,
            usage: allowUsage && cmd.includeUsage ? usage : null,
          } satisfies ProviderShareInsights;
        case 'received':
          return [share];
        case 'received-snapshot':
          return {
            ownerStamp: cmd.favoriteRecovery?.ownerStamp,
            received: [share],
            confirmedRegions: [],
          };
        case 'get-credential-consent':
          return { skip: false };
        case 'owned':
          return {
            ready: true,
            shares: [
              {
                shareId: share.shareId,
                providerId: 'xd',
                providerLabel: 'Cindy AI',
                createdAt: '2026-10-01T00:00:00Z',
                members: [],
                requests: [],
              },
            ],
          };
        case 'usage-history':
          return history;
        case 'own-usage':
          return { providerId: 'xd', local: null, devices: [], relays: [] };
        case 'get-run-limits':
          return {
            value: { ...DEFAULT_REMOTE_AGENT_LIMITS },
            defaults: { ...DEFAULT_REMOTE_AGENT_LIMITS },
            isCustomized: false,
            customizedKeys: [],
            usage: { total: 0, devices: 0, largestDevice: 0 },
          } satisfies RemoteAgentLimitsView;
        default:
          return forbid(`providerShare.${cmd.action}`)();
      }
    };
    return {
      deviceLink: {
        getState: async () => ({ linkStatus: 'online' }),
        listDevices: async () => ({ devices: [] }),
        onPresenceChanged: subscription('presence'),
        onStatusChanged: subscription('linkStatus'),
        onControlTargetChanged: subscription('controlTarget'),
      },
      providerGroup: {
        command: async (cmd: { action: string }) => (cmd.action === 'list' ? {} : null),
        onChanged: subscription('groupChanged'),
      },
      providerShare: {
        command,
        onOwnedChanged: subscription('ownedShares'),
        onReceivedChanged: subscription('receivedShares'),
      },
    };
  },
  render: (ctx) => (
    <AppFrame>
      <div className="flex h-full min-h-0 flex-col">
        <p className="shrink-0 px-5 py-2 text-12 text-[var(--text-secondary)]">
          UI fixture · 测试数据 · Test data
        </p>
        {ctx.case === 'owner' ? (
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
            <ProviderShareManagePage
              providerId="xd"
              providerName="Cindy AI"
              providerIcon={<span>C</span>}
              gate="on"
              onBack={() => {}}
            />
          </div>
        ) : (
          <ProviderShareReceivedDetail share={share} />
        )}
      </div>
    </AppFrame>
  ),
});
