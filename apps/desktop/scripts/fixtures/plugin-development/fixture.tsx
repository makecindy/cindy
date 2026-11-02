import { mountPage, subscription } from '../../ui-page/harness';
import { GhostPluginDetailView } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { GhostInstallConsentContent } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { toGhostPluginDetail } from '../../../src/renderer/features/plugin/lib/ghostPluginViewModel';
import { ghostPermissionItems, type InstalledGhost } from '../../../src/shared/ghost';

const ghost: InstalledGhost = {
  manifest: { schemaVersion: 3, id: 'browser-dev', name: 'Browser developer', description: 'Development copy with its own accounts and browser pairing.',
    version: '1.0.0', kind: 'chip', entry: 'main.js', showTaskPreferences: false,
    node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio' },
    browserExtension: { protocol: 'cindy-browser-extension/3', extensionIds: ['a'.repeat(32)], nativeHost: { name: 'com.example.browser', binary: 'native-host' }, pageControl: true },
    tools: [{ name: 'inspect', description: 'Read browser state', approval: 'auto' }],
  },
  namespace: 'local', namespaceState: 'confirmed', instanceKey: '_ns__local__browser-dev',
  publishingSource: { kind: 'local', source: 'agent-forge' }, dir: '/fixture/local/browser-dev', enabled: true,
  approval: { state: 'approved', revision: 'fixture-revision' }, approvedAutoTools: ['inspect'],
};
const noop = () => {};
mountPage({
  route: '/plugins',
  host: () => ({
    getFullscreenState: async () => false, onFullscreenChange: subscription('fullscreen'),
    ghosts: { activateBrowser: async () => ({ ok: true }), listSync: () => ({ ghosts: [ghost] }) },
  }),
  render: ctx => ctx.case === 'permissions'
    ? <main className="mx-auto max-w-xl p-6"><GhostInstallConsentContent facts={{ kind: 'install', ghostId: ghost.manifest.id,
      name: ghost.manifest.name, version: ghost.manifest.version, permissions: ghostPermissionItems(ghost.manifest) }} /></main>
    : <GhostPluginDetailView ghost={ghost} detail={toGhostPluginDetail(ghost)} panelStatus={null}
      onBack={noop} onToggle={noop} onUse={noop} onUpdate={noop} onUpdateFromFile={noop} onUninstall={noop} toggleDisabled={false} />,
});
