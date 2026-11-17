import { mountPage, subscription } from '../../ui-page/harness';
import { GhostPluginDetailView } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { MessageSourceLabels } from '../../../src/renderer/components/chat/MessageSourceLabels';
import { GhostInstallConsentContent } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { toGhostPluginDetail } from '../../../src/renderer/features/plugin/lib/ghostPluginViewModel';
import { ghostPermissionItems, type InstalledGhost } from '../../../src/shared/ghost';
import { MyPluginsPage } from '../../../src/renderer/features/plugin/MyPluginsPage';
import type { PluginContributionsApi, MyPluginDetailView, PreparedPluginContribution } from '../../../src/shared/pluginContributions';
import type { GhostPluginListItem } from '../../../src/renderer/features/plugin/lib/ghostPluginViewModel';

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
const marketGhost: InstalledGhost = { ...ghost, namespace: null, instanceKey: '_root__browser-dev',
  publishingSource: { kind: 'public-market', pluginId: 'fixture-plugin' } };
const hostToolsGhost: InstalledGhost = { ...ghost, manifest: { ...ghost.manifest,
  name: 'Task dashboard', agent: { hostTools: ['history', 'control', 'handoff', 'settings', 'scheduler'] },
  subscribe: { topics: ['message', 'task-state'] },
} };
const candidateInstances = [
  { instanceId: '_root__example', version: '1.0.0', origin: 'public' as const, enabled: true },
  { instanceId: '_ns__local__example', version: '1.1.0', origin: 'local' as const, enabled: true },
];
const authorDetail: MyPluginDetailView = {
  plugin: { pluginId: 'fixture-plugin', name: 'Example plugin', iconUrl: null, updatedAt: '2026-11-01T00:00:00Z',
    market: { state: 'available', version: '1.0.0', releaseId: 'published', reason: null }, latestSubmission: null,
    actions: { submitUpdate: true, viewMarket: true }, localInstanceId: null,
    localInstallation: { state: 'unavailable', candidates: candidateInstances } },
  history: [], nextCursor: null, queriedAt: '2026-11-01T00:00:00Z',
};
const unsupported = async (): Promise<never> => { throw new Error('Not part of this renderer fixture'); };
const authorApi: PluginContributionsApi = {
  reviewUpdates: async () => [], markReviewRead: async () => {},
  list: async () => ({ plugins: [authorDetail.plugin], nextCursor: null, queriedAt: authorDetail.queriedAt }),
  detail: async () => authorDetail, releases: async () => ({ releases: [], nextCursor: null, queriedAt: authorDetail.queriedAt }),
  prepare: async instanceId => ({ preparedId: 'preview', instanceId, pluginId: 'fixture-plugin', ghostId: 'example',
    name: 'Example plugin', description: 'Development version selected for review', version: '1.1.0',
    sha256: 'a'.repeat(64), sizeBytes: 100, expiresAt: '2099-01-01T00:00:00Z',
    preflight: { subject: { authority: 'https://example.test', membershipId: 'fixture-user' },
      queriedAt: authorDetail.queriedAt, policyVersion: 2,
      target: { pluginId: 'fixture-plugin', ghostId: 'example', version: '1.1.0', expectedRelease: null },
      pendingRelease: null, blockers: [], actions: { canSubmit: true } } } as PreparedPluginContribution),
  discard: async () => {}, submit: unsupported, status: unsupported, cancel: unsupported,
  cancelReview: unsupported, submission: unsupported, setAnonymity: unsupported,
};
const authorCache = {};
const noop = () => {};
mountPage({
  route: '/plugins?myPlugins=1&contribution=fixture-plugin',
  host: () => ({
    getFullscreenState: async () => false, onFullscreenChange: subscription('fullscreen'),
    ghosts: { activateBrowser: async () => ({ ok: true }), listSync: () => ({ ghosts: [ghost] }) },
  }),
  render: ctx => ctx.case === 'remote-source'
    ? <main className="p-6"><MessageSourceLabels sourcePlugin={{ pluginId: 'source-device::dashboard', name: 'Dashboard' }} /></main>
    : ctx.case === 'authoring'
    ? <MyPluginsPage reader={authorApi} cache={authorCache} installedPluginCount={2}
      localPlugins={candidateInstances.map(item => ({ id: item.instanceId, name: 'Example plugin', version: item.version } as GhostPluginListItem))}
      onViewLocal={noop} onSubmitUpdate={async instanceId => { document.documentElement.dataset.submittedInstance = instanceId; return false; }} />
    : ctx.case === 'permissions' || ctx.case === 'host-tool-permissions'
    ? <main className="mx-auto max-w-xl p-6"><GhostInstallConsentContent facts={{ kind: 'install', ghostId: ghost.manifest.id,
      name: ghost.manifest.name, version: ghost.manifest.version, permissions: ghostPermissionItems(ctx.case === 'host-tool-permissions' ? hostToolsGhost.manifest : ghost.manifest) }} /></main>
    : <GhostPluginDetailView ghost={ctx.case === 'market' ? marketGhost : ctx.case === 'host-tools' ? hostToolsGhost : ghost}
      detail={toGhostPluginDetail(ctx.case === 'market' ? marketGhost : ctx.case === 'host-tools' ? hostToolsGhost : ghost)} panelStatus={null}
      onBack={noop} onToggle={noop} onUse={noop} onUpdate={noop} onUpdateFromFile={noop} onUninstall={noop} toggleDisabled={false} />,
});
