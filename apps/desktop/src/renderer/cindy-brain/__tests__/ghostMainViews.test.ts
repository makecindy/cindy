import { describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { projectGhostMainViews } from '../ghostMainViews';

function ghost(
  id: string,
  overrides: Omit<Partial<InstalledGhost>, 'manifest'> & { manifest?: Partial<GhostManifest> } = {},
): InstalledGhost {
  return {
    dir: `/plugins/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    ...overrides,
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['main-view'],
      minCindyVersion: '1.0.0',
      mainView: { html: 'main-view.html' },
      ...overrides.manifest,
    },
  };
}

describe('projectGhostMainViews', () => {
  it('keeps declared, route-capable and sidebar-visible layers separate', () => {
    const hidden = new Set(['hidden']);
    const projection = projectGhostMainViews(
      [
        ghost('visible'),
        ghost('hidden'),
        ghost('disabled', { enabled: false }),
        ghost('unapproved', { approval: { state: 'invalid' } }),
        ghost('panel-only', { manifest: { slots: ['panel'], mainView: undefined } }),
      ],
      { locale: 'en', isSidebarVisible: (id) => !hidden.has(id) },
    );

    expect(projection.declared.map((item) => item.ghostId)).toEqual([
      'disabled',
      'hidden',
      'unapproved',
      'visible',
    ]);
    expect(projection.routeCapable.map((item) => item.ghostId)).toEqual(['hidden', 'visible']);
    expect(projection.sidebarVisible.map((item) => item.ghostId)).toEqual(['visible']);
  });

  it('uses the localized main-view title, falls back to plugin name and sorts stably', () => {
    const projection = projectGhostMainViews(
      [
        ghost('z-id', {
          manifest: {
            name: 'Beta',
            mainView: { html: 'view.html', title: 'Alpha', icon: 'globe' },
          },
        }),
        ghost('a-id', { manifest: { name: 'alpha' } }),
      ],
      { locale: 'en', isSidebarVisible: () => true },
    );

    expect(projection.declared.map(({ ghostId, title }) => [ghostId, title])).toEqual([
      ['a-id', 'alpha'],
      ['z-id', 'Alpha'],
    ]);
    expect(projection.declared.map(({ ghostId, icon }) => [ghostId, icon])).toEqual([
      ['a-id', 'puzzle'],
      ['z-id', 'globe'],
    ]);
  });
});
