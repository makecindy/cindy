import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelEffortChip } from '../../../src/renderer/features/scheduler/components/ScheduleChips';

function Fixture() {
  const [device, setDevice] = useState('');
  const [provider, setProvider] = useState('anthropic');
  return <main className="flex justify-end p-6">
    <div data-testid="automation-model" data-device={device} data-provider={provider}>
      <ModelEffortChip agentKind="claude-code" agentDeviceId={device}
        modelValue="claude-sonnet-4-6" providerId={provider} effortValue="high"
        onSelect={selection => { setDevice(selection.agentDevice?.deviceId ?? ''); setProvider(selection.providerId); }}
        onChangeProviderId={setProvider} onChangeModel={() => {}} onChangeEffort={() => {}} onFollowSession={() => {}} />
    </div>
  </main>;
}

void mountPage({
  host: { maker: {
    requestProviderModelsAutoRefresh: async () => undefined,
    onProvidersChanged: subscription('providersChanged'),
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
  }, safeStorageRead: async () => null,
    deviceLink: { invoke: async () => null, onRemotePush: subscription('remotePush'),
      onStatusChanged: subscription('remoteStatus'), onPresenceChanged: subscription('presence') },
  },
  render: () => <Fixture />,
});
