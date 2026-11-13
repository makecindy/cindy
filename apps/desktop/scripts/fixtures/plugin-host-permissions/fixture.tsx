import { mountPage, subscription } from '../../ui-page/harness';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { PermissionSummary } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { ghostHostUiPermissionItems, type GhostManifest } from '../../../src/shared/ghost';
import type { GhostInstallConsentRequest } from '../../../src/shared/ghostInstallConsent';

// Synthetic permissions only. The production consent/summary components render them.
const manifest: GhostManifest = { schemaVersion: 3, id: 'task-board', name: 'Task Board', version: '1.0.0', kind: 'chip', entry: 'main.js',
  tools: [{ name: 'filter_items', description: 'Synthetic item filter' }], mcpApps: { ui: { resources: [{ uri: 'ui://task-board/page', file: 'ui/page.html' }], tools: {} },
    host: { views: [{ id: 'board', title: 'Task Board', scope: 'task', resourceUri: 'ui://task-board/page' }],
      contributions: [{ id: 'attach', title: 'Filter files', position: 'composer.attachment', tool: 'filter_items',
        arguments: { tags: ['a', 'b'], done: false }, accept: { extensions: ['.pdf'] } },
      { id: 'complete', title: 'Complete items', position: 'composer.completion', tool: 'filter_items', trigger: '/' }],
      settings: [{ id: 'limit', title: 'Limit', type: 'number', default: 0, min: 0, max: 10 }],
      capabilities: ['draft'] } } };
const permissions = ghostHostUiPermissionItems(manifest);
void mountPage({
  host: { ghosts: {
    onInstallConsentRequest: (callback: (request: GhostInstallConsentRequest) => void) => subscription('hostConsent')(() => callback({
      requestId: 'fixture-host-permissions', initiator: 'user', origin: 'local-file',
      facts: { kind: 'install', ghostId: manifest.id, name: manifest.name, version: manifest.version, permissions },
    })),
    onInstallConsentDismissed: subscription('hostDismissed'),
    resolveInstallConsent: async () => ({ handled: true }),
  } },
  render: ctx => ctx.case === 'default'
    ? <GhostInstallConsentHost />
    : <main className="mx-auto max-w-2xl p-5"><PermissionSummary items={permissions} /></main>,
});
