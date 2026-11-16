import { useTranslation } from 'react-i18next';

import { mountPage, subscription } from '../../ui-page/harness';
import { ProviderGroupSection } from '../../../src/renderer/features/provider-group/ProviderGroupSection';
import { RemoteProviderGroupMembers } from '../../../src/renderer/features/provider-group/RemoteProviderGroupMembers';
import type { ProviderGroupMemberStatus, ProviderGroupView } from '../../../src/shared/providerGroup';

const now = Date.now();
const cases: Array<Pick<ProviderGroupMemberStatus, 'label' | 'state' | 'running' | 'usageLimit' | 'coolingUntil'>> = [
  { label: 'Mac Studio', state: 'available', running: 0 },
  { label: 'Work PC', state: 'available', running: 2 },
  { label: 'XD-1254678', state: 'cooling', running: 0, usageLimit: { resetAtMs: now + (6 * 24 + 1) * 3_600_000 } },
  { label: 'Windows Laptop', state: 'cooling', running: 2, usageLimit: { resetAtMs: null } },
  { label: 'Mac mini', state: 'cooling', running: 0, coolingUntil: now + 30 * 60_000 },
];
const members = cases.map((item, index) => ({
  key: index === 0 ? 'local' : `device:computer-${index}:openai`,
  kind: index === 0 ? 'local' as const : 'device' as const,
  agentDeviceId: index === 0 ? null : `computer-${index}`,
  providerId: 'openai', label: item.label, limit: 16, weight: 1, paused: false,
}));
const view: ProviderGroupView = {
  providerId: 'openai',
  config: { strategy: 'least', autoSwitch: true, members },
  members: members.map((member, index) => ({ ...member, ...cases[index], appVersion: '0.1.113' })),
};

function Fixture({ remote }: { remote: boolean }) {
  const { t } = useTranslation();
  return (
    <main className="mx-auto w-full min-w-0 max-w-[1000px] p-4">
      {remote ? (
        <>
          <h1 className="mb-3 text-14 font-medium">{t('providerGroup.section.title')}</h1>
          <RemoteProviderGroupMembers deviceId="group-host" providerId="openai" config={view.config!} />
        </>
      ) : <ProviderGroupSection providerId="openai" providerName="OpenAI" />}
    </main>
  );
}

void mountPage({
  host: {
    providerGroup: {
      command: async (command: { action: string }) => {
        if (command.action === 'list') return { openai: view.config };
        if (command.action === 'get' || command.action === 'remote-view') return view;
        throw new Error(`Unexpected group write: ${command.action}`);
      },
      onChanged: subscription('groupChanged'),
    },
    deviceLink: { listDevices: async () => ({ devices: [] }) },
    providerShare: {
      command: async (command: { action: string; favoriteRecovery?: { ownerStamp: unknown } }) => command.action === 'received-snapshot'
        ? { ownerStamp: command.favoriteRecovery?.ownerStamp, received: [], confirmedRegions: [] }
        : [],
      onReceivedChanged: subscription('receivedShares'),
    },
  },
  render: (ctx) => <Fixture remote={ctx.case === 'remote'} />,
});
