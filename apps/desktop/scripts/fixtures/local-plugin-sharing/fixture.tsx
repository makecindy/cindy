import { mountPage, subscription } from '../../ui-page/harness';
import { PluginShareButton } from '../../../src/renderer/features/plugin/PluginShareButton';
import { LocalPluginShareView } from '../../../src/renderer/features/plugin/LocalPluginShareView';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import type { InstalledGhost } from '../../../src/shared/ghost';
import { useState } from 'react';
import type { CatalogDevice } from '../../../src/renderer/features/plugin/useCatalogDevice';
import { REMOTE_RESOURCE_MANIFEST_CHANNEL } from '@cindy/device-link';
import { InteractivePreview, interactiveHost } from './interactive';

const ghost: InstalledGhost = {
  manifest: { schemaVersion: 3, id: 'local-share-example', name: '我的本地插件', description: '用于演示按次分享的本地插件。', version: '1.0.0', entry: 'index.js', kind: 'chip',
    network: { hosts: ['api.example.test'] } },
  namespace: null, namespaceState: 'confirmed', instanceKey: '_root__local-share-example',
  dir: '/fixture/local-share-example', enabled: true, publishingSource: { kind: 'local', source: 'manual' },
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
};
const snapshotId = 'a'.repeat(32);
const snapshot = { schemaVersion: 1, snapshotId, ghostId: ghost.manifest.id, version: ghost.manifest.version,
  name: ghost.manifest.name, description: ghost.manifest.description, author: null, icon: null,
  sha256: 'a'.repeat(64), sizeBytes: 1024, createdAt: '2026-10-28T00:00:00.000Z' };

const target = { deviceId: 'fixture-target', name: 'Studio Computer' };
const candidate = { ...target, platform: 'darwin', appVersion: '0.1.200', lastSeenAt: null, online: true,
  busy: false, isSelf: false, controlEnabled: true, remoteControlEnabled: true };
function Preview({ receiver, scene }: { receiver: boolean; scene: string }) {
  const [selected, setSelected] = useState<CatalogDevice | null>(scene.startsWith('remote') ? target : null);
  const online = scene !== 'remote-offline';
  return <main className="h-screen">
    {receiver ? <LocalPluginShareView snapshotId={snapshotId} onBack={() => {}} onInstalled={() => {}}
      deviceControl={{ selected, onSelect: setSelected, directory: { candidates: [{ ...candidate, online }], target: selected ? { ...candidate, online } : undefined, online: !selected || online, relayOnline: true } }} />
      : <div className="flex items-center gap-4 p-6"><span>{ghost.manifest.name}</span><PluginShareButton ghost={ghost} /></div>}
    <GhostInstallConsentHost />
  </main>;
}

mountPage({
  route: '/plugins',
  host: ctx => ({
    getFullscreenState: async () => false, onFullscreenChange: subscription('fullscreen'),
    ghosts: { onInstallConsentRequest: subscription('consent'), onInstallConsentDismissed: subscription('dismissed'),
      resolveInstallConsent: async () => ({ handled: true }) },
    deviceLink: { invoke: async (device, channel, [request]) => {
      if (device !== target.deviceId) throw new Error('Wrong install target');
      if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
      if (request.actionId === 'management:snapshot') return { effects: [], result: { version: 1, ghosts: [],
        market: { items: [], customSourceNames: [], unavailableCustomSourceNames: [] }, ...(ctx.case === 'remote-unsupported' ? {} : { localShares: true }) } };
      return { effects: [], result: { operationId: request.input.operationId, phase: 'confirmation', consent: {
        requestId: 'fixture-consent', initiator: 'user', origin: 'local-file',
        ...(ctx.case === 'remote-replace' ? { purpose: 'share-replace' as const,
          target: { namespace: null, sourceChanged: false, otherCopies: 0 } } : {}),
        facts: ctx.case === 'remote-replace'
          ? { kind: 'update', ghostId: snapshot.ghostId, name: snapshot.name, version: snapshot.version, previousVersion: snapshot.version,
            added: [], removed: [], unchangedCount: 1, builtinOauthClientChanged: false }
          : { kind: 'install', name: snapshot.name, version: snapshot.version,
            permissions: [{ key: 'network:host:api.example.test', kind: 'network', labelKey: 'networkHost', labelArgs: { host: 'api.example.test' } }] },
      } } };
    } },
    pluginMarket: {
      releaseLocalShare: async () => {},
      prepareLocalShare: async (_instance, _operation, _options, _binding, confirmed) => {
        if (!confirmed) await new Promise<void>(resolve => {
          window.addEventListener('local-share-check-complete', () => resolve(), { once: true });
        });
        if (ctx.case === 'changed') throw new Error('[PRECONDITION_FAILED] Package changed');
        return !confirmed && ctx.case !== 'reused'
          ? { confirmationRequired: true as const }
          : { title: snapshot.name, url: `https://share.example.test/s/${snapshotId}`,
            imageSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><text x="80" y="160" font-size="50">${snapshot.name} · v1.0.0</text></svg>` };
      },
      localShareDetail: ctx.case === 'login' ? () => { throw new Error('Package read before login'); } : async () => snapshot,
      // The check supplies the original host dialog request via the harness event.
      installLocalShare: async () => new Promise(() => {}),
    },
    ...(ctx.case === 'interactive' ? interactiveHost : {}),
  }),
  render: ctx => ctx.case === 'interactive' ? <InteractivePreview /> : <Preview receiver={ctx.case.startsWith('recipient') || ctx.case.startsWith('remote') || ctx.case === 'login'} scene={ctx.case} />,
});
