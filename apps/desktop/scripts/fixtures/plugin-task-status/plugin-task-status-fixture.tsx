import React from 'react';
import { ctx, mountPage, subscription } from '../../ui-page/harness';
import { PluginTaskStatus } from '../../../src/renderer/cindy-brain/PluginTaskStatus';
import type { InstalledGhost } from '../../../src/shared/ghost';

const ghost: InstalledGhost = {
  manifest: {
    schemaVersion: 3,
    id: 'quota-demo',
    name: 'Quota',
    version: '1.0.0',
    entry: 'main.js',
    taskView: { html: 'task.html', statusBar: true },
  },
  dir: '/fixture/quota-demo',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
};

void mountPage({
  host: {
    ghosts: {
      listSync: () => ({ ghosts: [ghost] }),
      onChanged: subscription('ghosts-changed'),
      taskStatus: async () => [
        {
          instanceId: 'quota-demo',
          name: 'Quota',
          label:
            ctx.case === 'narrow'
              ? 'Long status with quota remaining 50%, refresh pending'
              : '50% remaining',
          tooltip: 'Remaining quota from the plugin',
        },
      ],
    },
  },
  render: () => (
    <main className="p-4">
      <PluginTaskStatus sessionId="fixture-task" />
    </main>
  ),
});
