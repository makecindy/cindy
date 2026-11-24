import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { GhostPluginActions } from '../../../src/renderer/features/plugin/GhostPluginActions';
import { InstallGithubReleaseDialog } from '../../../src/renderer/features/plugin/InstallGithubReleaseDialog';
import { useConfirmDialog } from '../../../src/renderer/components/ui/confirm-dialog-provider';

function Fixture() {
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState('');
  const { confirm } = useConfirmDialog();
  window.electronAPI.ghosts.installGithubRelease = async (action, url) => {
    if (action === 'sign-in') return true;
    if (url !== 'https://github.com/example/plugin/releases/tag/v1.2.3') return { status: 'sign-in' };
    const approved = await confirm({ title: 'Example Plugin', description: '1.2.3', confirmText: 'Install example' });
    return approved ? { status: 'installed', instanceId: 'example-plugin', version: '1.2.3' } : { status: 'unavailable' };
  };
  return (
    <main className="flex justify-end p-4">
      <GhostPluginActions onInstall={() => {}} onInstallGithubRelease={() => setOpen(true)} />
      {open && <InstallGithubReleaseDialog onClose={() => setOpen(false)} onInstalled={(id) => { setInstance(id); setOpen(false); }} />}
      <output hidden data-testid="install-result">{instance}</output>
    </main>
  );
}

void mountPage({ host: { ghosts: {} }, render: () => <Fixture /> });
