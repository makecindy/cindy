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
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1',
      kind: 'chip',
      entry: 'main.js',
      tools: (options.tools ?? ['run']).map((name) => ({
        name,
        description: name,
      })),
    },
  };
}

describe('GhostSetupManifestTracker', () => {
  it('tracks colliding ids independently by physical instance', () => {
    const bus = new GhostSetupChangeBus();
    const onRoot = vi.fn();
    const onOrg = vi.fn();
    bus.subscribe('helper', onRoot);
    bus.subscribe('_ns__acme__helper', onOrg);
    const tracker = new GhostSetupManifestTracker(bus, () => true);
    const root = ghost('helper');
    const org = { ...ghost('helper'), namespace: 'acme', dir: '/plugins/_ns/acme/helper' };
    tracker.seed([root, org]);
    expect(tracker.note([{ ...root, enabled: false }, org])).toEqual(['helper']);
    expect(onRoot).toHaveBeenCalledTimes(1);
    expect(onOrg).not.toHaveBeenCalled();
    expect(tracker.note([{ ...root, enabled: false }, { ...org, enabled: false }])).toEqual(['_ns__acme__helper']);
    expect(onOrg).toHaveBeenCalledTimes(1);
    expect(tracker.note([{ ...root, enabled: false }])).toEqual(['_ns__acme__helper']);
    expect(onOrg).toHaveBeenCalledTimes(2);
  });

  it('keeps the bare physical id for an in-place namespace stamp', () => {
    const bus = new GhostSetupChangeBus();
    const listener = vi.fn();
    bus.subscribe('helper', listener);
    const tracker = new GhostSetupManifestTracker(bus, () => true);
    const org = { ...ghost('helper'), namespace: 'acme' };
    tracker.seed([org]);
    expect(tracker.note([{ ...org, enabled: false }])).toEqual(['helper']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('checks availability against each installed physical id', () => {
    const availability = vi.fn((_instanceId: string) => true);
    const tracker = new GhostSetupManifestTracker(new GhostSetupChangeBus(), availability);
    tracker.seed([ghost('helper'), { ...ghost('helper'), namespace: 'acme', dir: '/plugins/_ns/acme/helper' }]);
    expect(availability.mock.calls.map(([instanceId]) => instanceId)).toEqual([
      'helper', '_ns__acme__helper',
    ]);
  });
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
