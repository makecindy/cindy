import { mountPage, subscription } from '../../ui-page/harness';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { UpdateAllConsent } from '../../../src/renderer/features/plugin/lib/updateAllConsent';
import { PermissionSummary } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { ghostHostUiPermissionItems, ghostPermissionItems, type GhostManifest } from '../../../src/shared/ghost';
import type { GhostInstallConsentRequest } from '../../../src/shared/ghostInstallConsent';

// Synthetic permissions only. The production consent/summary components render them.
const manifest: GhostManifest = { schemaVersion: 3, id: 'task-board', name: 'Task Board', version: '1.0.0', kind: 'chip', entry: 'main.js',
  agent: { hostTools: ['usage'] },
  tools: [{ name: 'filter_items', description: 'Synthetic item filter' }], mcpApps: { ui: { resources: [{ uri: 'ui://task-board/page', file: 'ui/page.html' }], tools: {} },
    host: { views: [{ id: 'board', title: 'Task Board', scope: 'task', resourceUri: 'ui://task-board/page' }],
      contributions: [{ id: 'attach', title: 'Filter files', position: 'composer.attachment', tool: 'filter_items',
        arguments: { tags: ['a', 'b'], done: false }, accept: { extensions: ['.pdf'] } },
      { id: 'complete', title: 'Complete items', position: 'composer.completion', tool: 'filter_items', trigger: '/' }],
      settings: [{ id: 'limit', title: 'Limit', type: 'number', default: 0, min: 0, max: 10 }],
      capabilities: ['draft'] } } };
const permissions = [...ghostHostUiPermissionItems(manifest),
  ...ghostPermissionItems(manifest).filter(item => item.key === 'agent:host-tools:usage')];
void mountPage({
  host: { ghosts: {
    onInstallConsentRequest: (callback: (request: GhostInstallConsentRequest) => void) => subscription('hostConsent')(async event => {
      if (event && typeof event === 'object' && 'batch' in event && event.batch) {
        const batch = new UpdateAllConsent();
        for (const name of ['Task Board', 'Notes']) {
          const row = batch.track(async batchRowId => {
            callback({ batchRowId, initiator: 'user', origin: 'market', requestId: name,
              facts: { kind: 'update', name, ghostId: name, version: '1.1.0', previousVersion: '1.0.0',
                added: permissions.slice(-1), removed: [], unchangedCount: 1, builtinOauthClientChanged: false } });
          });
          await row.ready;
        }
        void batch.finish();
        return;
      }
      callback({ requestId: 'fixture-host-permissions', initiator: 'user', origin: 'local-file',
        facts: { kind: 'install', ghostId: manifest.id, name: manifest.name, version: manifest.version, permissions } });
    }),
    onInstallConsentDismissed: subscription('hostDismissed'),
    resolveInstallConsent: async () => ({ handled: true }),
  } },
  render: ctx => ctx.case !== 'details'
    ? <GhostInstallConsentHost />
    : <main className="mx-auto max-w-2xl p-5"><PermissionSummary items={permissions} /></main>,
});
