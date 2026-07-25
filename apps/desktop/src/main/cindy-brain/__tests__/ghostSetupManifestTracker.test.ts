import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostSetupChangeBus } from '../ghostSetupChangeBus';
import { GhostSetupManifestTracker } from '../ghostSetupManifestTracker';

function ghost(
  id: string,
  options: { enabled?: boolean; tools?: string[] } = {},
): InstalledGhost {
  return {
    dir: `/plugins/${id}`,
    enabled: options.enabled ?? true,
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: (options.tools ?? ['run']).map((name) => ({
        name,
        description: name,
      })),
    },
  };
}

describe('GhostSetupManifestTracker', () => {
  it('emits only for install, update, enable/disable, and uninstall diffs', () => {
    const bus = new GhostSetupChangeBus();
    const listener = vi.fn();
    bus.subscribe('gmail', listener);
    const tracker = new GhostSetupManifestTracker(bus, () => true);
    tracker.seed([]);

    const installed = ghost('gmail');
    expect(tracker.note([installed])).toEqual(['gmail']);
    expect(tracker.note([installed])).toEqual([]);
    expect(tracker.note([{ ...installed, enabled: false }])).toEqual(['gmail']);
    expect(tracker.note([ghost('gmail', { tools: ['search'] })])).toEqual(['gmail']);
    expect(tracker.note([])).toEqual(['gmail']);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls.every(([event]) => event.source === 'manifest')).toBe(true);
  });

  it('emits when session capability changes plugin availability', () => {
    const bus = new GhostSetupChangeBus();
    let available = true;
    const tracker = new GhostSetupManifestTracker(bus, () => available);
    const installed = ghost('cindy-art');
    tracker.seed([installed]);
    available = false;

    expect(tracker.note([installed])).toEqual(['cindy-art']);
    expect(bus.currentRevision('cindy-art')).toBe(1);
  });
});
