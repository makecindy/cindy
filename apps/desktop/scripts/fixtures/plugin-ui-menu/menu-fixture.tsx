import { mountPage, subscription } from '../../ui-page/harness';
import { PluginUiMenu, PluginUiProvider } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { WINDOW_DRAG_STYLE } from '../../../src/renderer/components/layout/windowDrag';
import type { InstalledGhost } from '../../../src/shared/ghost';

const ghost: InstalledGhost = {
  enabled: true, dir: '/fixture', approval: { state: 'approved', revision: 'one' },
  manifest: { schemaVersion: 3, id: 'planner', name: 'Planner', kind: 'chip',
    entry: 'main.js', version: '1', tools: [], mcpApps: {
      ui: { resources: [{ uri: 'ui://view', file: 'view.html' }], tools: {} },
      host: { views: [{ id: 'view', title: 'View', resourceUri: 'ui://view', scope: 'task' }] },
    } },
};

mountPage({
  host: () => ({ ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: subscription('ghosts') } }),
  render: () => <PluginUiProvider>
    <header data-testid="drag-header" style={WINDOW_DRAG_STYLE} className="flex h-12 items-center justify-end border-b px-4">
      <PluginUiMenu sessionId="fixture-task" />
    </header>
  </PluginUiProvider>,
});
