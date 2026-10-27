import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderUsageSection } from '../../../src/renderer/features/provider-share/ProviderUsageSection';
import { useShareTimeFormat } from '../../../src/renderer/features/provider-share/useShareTimeFormat';
import type { ProviderGroupConfig } from '../../../src/shared/providerGroup';
import type { ProviderShareMemberView, ProviderUsageHistoryView } from '../../../src/shared/providerShare';

const group: ProviderGroupConfig = {
  strategy: 'least', autoSwitch: true,
  members: [
    { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'xd', limit: 4, weight: 1, paused: false },
    { key: 'device:studio:xd', kind: 'device', agentDeviceId: 'studio', providerId: 'xd', limit: 4, weight: 1, paused: false },
  ],
};
const day = (date: string, model: string, inputTokens: number, memberKey = 'local') => ({
  day: date, kind: 'claude-code', providerId: 'xd', model, memberKey,
  turns: 3, inputTokens, outputTokens: 1_000, cacheReadTokens: 8_000, cacheCreateTokens: 2_000,
  amount: { amount: 1.25, currency: 'USD' as const },
});
const history: ProviderUsageHistoryView = {
  providerId: 'xd', todayKey: '2026-10-19', coverageStart: null,
  self: { lastUsedAt: Date.parse('2026-10-19T12:00:00Z'), days: [
    day('2026-10-19', 'claude-sonnet-4-6', 41_000),
    day('2026-10-18', 'claude-opus-4-6', 9_000, 'device:studio:xd'),
    day('2026-10-17', 'claude-opus-4-6', 19_000, 'device:retired:xd'),
  ] },
  relays: [],
  members: [{ shareId: 'share-1', memberId: 'member-1', lastUsedAt: Date.parse('2026-10-19T11:00:00Z'), days: [
    day('2026-10-19', 'claude-opus-4-6', 310_000, 'device:studio:xd'),
  ] }],
};
const members: ProviderShareMemberView[] = [{
  shareId: 'share-1', memberId: 'member-1', displayName: 'Alex', avatarUrl: null, region: 'global',
  status: 'active', joinedAt: '2026-10-01T00:00:00Z', lastUsedAt: Date.parse('2026-10-19T11:00:00Z'),
  runningTasks: 1, models: [],
}];

function Fixture({ grouped }: { grouped: boolean }) {
  const time = useShareTimeFormat();
  const unexpectedAction = () => { throw new Error('This usage fixture must not change sharing'); };
  return (
    <main className="mx-auto w-full max-w-[1100px] min-w-0 p-4">
      <ProviderUsageSection
        providerId="xd"
        history={history}
        status="ready"
        legacyOwn={null}
        members={members}
        groupConfig={grouped ? group : null}
        selfDeviceName="Mac Mini"
        time={time}
        memberActions={{ busy: () => false, canApproveReshare: false, onTogglePause: unexpectedAction, onRemove: unexpectedAction, onReshare: unexpectedAction }}
      />
    </main>
  );
}

void mountPage({
  host: {
    deviceLink: {
      getState: async () => ({ linkStatus: 'online' }),
      listDevices: async () => ({ devices: [
        { deviceId: 'studio', name: 'Studio', platform: 'darwin', online: true, remoteControlEnabled: true, controlEnabled: true, isSelf: false },
        { deviceId: 'retired', name: 'Retired Studio', platform: 'darwin', online: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false },
      ] }),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onControlTargetChanged: subscription('controlTarget'),
    },
    providerGroup: { command: async () => ({}), onChanged: subscription('groupChanged') },
    providerShare: {
      command: async (command: { action: string; favoriteRecovery?: { ownerStamp: unknown } }) => command.action === 'received-snapshot'
        ? { ownerStamp: command.favoriteRecovery?.ownerStamp, received: [], confirmedRegions: [] }
        : [],
      onReceivedChanged: subscription('receivedShares'),
    },
  },
  render: (ctx) => <Fixture grouped={ctx.case !== 'no-group'} />,
});
