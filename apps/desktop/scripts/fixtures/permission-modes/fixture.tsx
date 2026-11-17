import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { PermissionSelector } from '../../../src/renderer/components/new-chat/PermissionSelector';
import type { PermissionMode } from '../../../src/renderer/lib/userPreferences.types';

function Fixture({ scenario }: { scenario: string }) {
  const [mode, setMode] = useState<PermissionMode>('auto');
  return <div className="p-8 text-[var(--text-primary)]">
    {scenario === 'collapsed' ? <div className="flex flex-col gap-5">
      {(['ask', 'acceptEdits', 'auto', 'bypassPermissions'] as const).map(value =>
        <PermissionSelector key={value} permissionMode={value} onPermissionModeChange={setMode} />)}
    </div> : <div data-picker className={scenario === 'field' ? 'w-[300px]' : 'mt-[350px]'}>
      <PermissionSelector permissionMode={mode} onPermissionModeChange={setMode}
        iconOnly={scenario === 'compact'} triggerVariant={scenario === 'field' ? 'field' : 'chip'} />
    </div>}
  </div>;
}
void mountPage({
  host: { maker: { getCapabilities: async () => ({
    hasFastMode: false, availableModels: [], effortLevels: [],
    permissionModes: ['ask', 'acceptEdits', 'auto', 'bypassPermissions'].map(id => ({ id, displayName: id })),
  }) } },
  render: ctx => <Fixture scenario={ctx.case} />,
});
