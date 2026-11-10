import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderGroupSection } from '../../../src/renderer/features/provider-group/ProviderGroupSection';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../src/shared/claudeSubscriptionUsage';
import type { ProviderGroupView } from '../../../src/shared/providerGroup';
import type {
  SubscriptionAccountView,
  SubscriptionPoolView,
} from '../../../src/shared/subscriptionAccounts';

const now = Date.now();
const hours = (value: number) => Math.round(now / 1000 + value * 3600);
const claude = (
  fiveHour: number,
  sevenDay: number,
  fable: number | null,
): ClaudeSubscriptionUsageSnapshot => ({
  source: 'oauth-endpoint',
  updatedAt: now,
  subscriptionType: 'max',
  fiveHour: { utilization: fiveHour, resetsAt: hours(3.2) },
  sevenDay: { utilization: sevenDay, resetsAt: hours(46) },
  scoped:
    fable === null
      ? []
      : [
          {
            modelId: 'claude-fable',
            modelDisplayName: 'Fable',
            utilization: fable,
            resetsAt: hours(46),
          },
        ],
});
const defaultUsage = claude(0, 94, 16);
const account = (id: string, patch: Partial<SubscriptionAccountView>): SubscriptionAccountView => ({
  id,
  paused: false,
  limit: 4,
  weight: 1,
  directory: `/fixture/${id}`,
  status: 'ready',
  running: 0,
  ...patch,
});
const member = {
  key: 'local',
  kind: 'local' as const,
  agentDeviceId: null,
  providerId: 'anthropic',
  label: 'Mac mini',
  limit: 10,
  weight: 1,
  paused: false,
};
const view: ProviderGroupView = {
  providerId: 'anthropic',
  config: { strategy: 'least', autoSwitch: true, members: [member] },
  members: [{ ...member, state: 'available', running: 0, appVersion: '0.1.130' }],
};

type AccountScenario = {
  states?: boolean;
  long?: boolean;
  single?: boolean;
  missingUsage?: boolean;
  singleAdded?: 'paused' | 'signed-out';
};

function pool(data: AccountScenario): SubscriptionPoolView {
  const first = account('default', {
    identity: data.long
      ? 'a-very-long-account-name-for-the-default-subscription@example.com'
      : 'first@example.com',
    usage: { claude: defaultUsage },
  });
  const second = account('work', {
    identity: data.long
      ? 'another-very-long-account-name-for-work@example.com'
      : 'second@example.com',
    paused: data.states || data.singleAdded === 'paused',
    status: data.singleAdded === 'signed-out' ? 'signed-out' : 'ready',
    usage:
      data.missingUsage || data.singleAdded === 'signed-out'
        ? undefined
        : { claude: claude(12, 40, null) },
  });
  return {
    providerId: 'anthropic',
    configured: !data.single,
    strategy: 'least',
    accounts: data.singleAdded
      ? [account('default', { status: 'signed-out' }), second]
      : data.single
        ? [first]
        : data.states
          ? [
              first,
              second,
              account('home', { identity: 'third@example.com', status: 'signed-out' }),
            ]
          : [first, second],
  };
}

void mountPage({
  host: (ctx) => ({
    providerGroup: {
      command: async (command: { action: string }) => {
        if (command.action === 'list') return { anthropic: view.config };
        if (command.action === 'get' || command.action === 'remote-view') return view;
        throw new Error(`Unexpected group write: ${command.action}`);
      },
      onChanged: subscription('groupChanged'),
    },
    subscriptionAccounts: {
      command: async () => pool(ctx.data as AccountScenario),
      onChanged: subscription('subscriptionAccounts'),
    },
    maker: {
      usage: {
        getClaudeSubscription: async () => defaultUsage,
        onClaudeSubscriptionChanged: subscription('claudeUsage'),
      },
    },
    deviceLink: {
      listDevices: async () => ({ devices: [] }),
      getState: async () => ({ linkStatus: 'online' }),
      onPresenceChanged: subscription('devicePresence'),
      onStatusChanged: subscription('deviceStatus'),
      onControlTargetChanged: subscription('deviceControl'),
    },
    providerShare: {
      command: async (command: { action: string; favoriteRecovery?: { ownerStamp: unknown } }) =>
        command.action === 'received-snapshot'
          ? { ownerStamp: command.favoriteRecovery?.ownerStamp, received: [], confirmedRegions: [] }
          : [],
      onReceivedChanged: subscription('receivedShares'),
    },
  }),
  render: () => (
    <main className="mx-auto w-full min-w-0 max-w-[900px] p-4">
      <ProviderGroupSection providerId="anthropic" providerName="Anthropic" />
    </main>
  ),
});
