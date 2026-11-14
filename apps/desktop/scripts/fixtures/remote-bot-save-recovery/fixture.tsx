import { useRef, useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { Button } from '../../../src/renderer/components/ui/button';
import { BotSettings } from '../../../src/renderer/features/bots/BotsHomeView';
import { BotSettingsTargetContext } from '../../../src/renderer/features/bots/botSettingsTarget';
import { localBotSettingsTarget } from '../../../src/renderer/features/bots/localBotSettingsTarget';
import { normalizeDbProfile } from '../../../src/renderer/features/bots/botStore';
import { createIpcError } from '../../../src/shared/ipc-errors';

const primary = { harness: 'claude' as const, model: 'fixture-sonnet', providerId: null, effort: 'high', fastMode: false };
const bot = normalizeDbProfile({ id: 'fixture-linux', name: 'Linux', status: 'active', avatar: '🐧', avatarColor: 'teal',
  capabilities: { harness: primary.harness, modelChain: [primary], modelChainOverride: [primary],
    taskModelOverride: { ...primary, model: 'fixture-opus', effort: 'medium' } },
})!;
let writes = 0;
const target = { ...localBotSettingsTarget, kind: 'remote' as const, deviceId: 'fixture-device', deviceName: 'Synthetic Linux',
  pages: new Set(['profile', 'model']), useRoster: () => [], useHiddenVendors: () => [], useDefaultModelChain: () => [primary],
  profile: { ...localBotSettingsTarget.profile, update: async () => {
    writes++;
    document.documentElement.dataset.fixtureWrites = String(writes);
    throw createIpcError('DEVICE_LINK_TIMEOUT', 'Synthetic save timeout');
  } },
};
function Fixture() {
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  const [closed, setClosed] = useState(false);
  return <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <div className="mx-auto w-full max-w-[448px]" data-save-recovery>
      {closed ? <p data-closed>Closed</p> : <>
        <Button onClick={() => void guard.current?.().then(allow => { if (allow) setClosed(true); })} data-close>Close settings</Button>
        <BotSettingsTargetContext.Provider value={target}>
          <BotSettings bot={bot} beforeCloseRef={guard} onBack={() => setClosed(true)} onOpenSession={() => {}} />
        </BotSettingsTargetContext.Provider>
      </>}
    </div>
  </main>;
}
void mountPage({
  route: '/bots/fixture-linux', render: () => <Fixture />,
  host: { deviceLink: {
    listDevices: async () => ({ devices: [] }),
    onPresenceChanged: subscription('presence'), onControlTargetChanged: subscription('controlTarget'),
    invoke: async (_device: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [] };
      if (channel === 'maker:list-available-agents') return ['claude-code'];
      if (channel === 'maker:get-capabilities') return { availableModels: [], effortLevels: [], permissionModes: [] };
      throw new Error(`Unexpected fixture channel: ${channel}`);
    },
  } },
});
