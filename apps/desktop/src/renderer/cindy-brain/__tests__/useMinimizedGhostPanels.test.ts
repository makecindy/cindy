import { describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { selectMinimizedGhostPanels } from '../useMinimizedGhostPanels';

function ghost(
  id: string,
  options: { enabled?: boolean; panel?: boolean; position?: 'left' | 'tab' } = {},
): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: options.panel === false ? [] : ['panel'],
    ...(options.panel === false
      ? {}
      : { panel: { html: 'panel.html', position: options.position ?? 'left' } }),
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled: options.enabled ?? true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

describe('selectMinimizedGhostPanels', () => {
  it('只返回启用、停靠、已最小化且未抽离的插件面板', () => {
    const ghosts = [
      ghost('ready'),
      ghost('open'),
      ghost('disabled', { enabled: false }),
      ghost('tab', { position: 'tab' }),
      ghost('tool', { panel: false }),
      ghost('detached'),
    ];

    expect(
      selectMinimizedGhostPanels(
        ghosts,
        {
          ready: { minimized: true },
          open: { minimized: false },
          disabled: { minimized: true },
          tab: { minimized: true },
          tool: { minimized: true },
          detached: { minimized: true },
        },
        { detached: { detached: true, open: true, lastOpen: true } },
      ).map((item) => item.manifest.id),
    ).toEqual(['ready']);
  });
});
