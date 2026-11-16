import { useState } from 'react';
import type { Schedule } from '@cindy/maker-scheduler';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { ModelEffortChip } from '../../../src/renderer/features/scheduler/components/ScheduleChips';
import { ScheduleFormDialog } from '../../../src/renderer/features/scheduler/components/ScheduleFormDialog';

// UI integration: exercise the real editor and picker, including the modal's
// stacking context. The fixture save boundary round-trips the submitted JSON;
// it deliberately does not write to the user's scheduler or execute a task.
function SpeedEditor() {
  const [saved, setSaved] = useState<Schedule>({
    id: 'speed-fixture', name: '自动化速度验证', prompt: '总结项目动态。',
    agentKind: 'codex', modelAgentKind: 'codex', model: 'gpt-6.1-sol', providerId: 'openai',
    modelAgentDeviceId: ctx.case === 'shared-speed' ? 'shared:fixture' : '',
    effort: 'high', fastMode: false, manual: true, recurring: true,
    cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', workspaceKind: 'dialogue',
    useWorktree: false, notify: { desktop: false, feishu: false },
    status: 'paused', kind: 'cron', source: 'user', jobType: 'prompt', createdAt: 1, updatedAt: 1,
  });
  const [open, setOpen] = useState(true);
  return <>
    <button data-ui-page-control data-testid="reopen-editor" data-saved-speed={String(saved.fastMode)}
      onClick={() => setOpen(true)}>重新编辑</button>
    {open && <ScheduleFormDialog open initial={saved} onOpenChange={setOpen}
      onSubmit={async input => { setSaved(JSON.parse(JSON.stringify({ ...saved, ...input }))); }} />}
  </>;
}

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
  route: '/cc-agent/scheduled',
  host: { maker: {
    listAvailableAgents: async () => ['claude-code', 'codex'],
    onAgentsChanged: subscription('agentsChanged'),
    schedule: {
      webhookReceiver: async () => 'cloud',
      scriptCapabilityStatus: async () => ({ statuses: [] }),
    },
    requestProviderModelsAutoRefresh: async () => undefined,
    onProvidersChanged: subscription('providersChanged'),
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
  }, safeStorageRead: async () => null,
    deviceLink: { invoke: async () => null, onRemotePush: subscription('remotePush'),
      onStatusChanged: subscription('remoteStatus'), onPresenceChanged: subscription('presence') },
  },
  render: () => ctx.case.endsWith('speed') ? <SpeedEditor /> : <Fixture />,
});
