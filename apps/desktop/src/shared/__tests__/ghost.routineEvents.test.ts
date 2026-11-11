import { describe, expect, it } from 'vitest';
import { validateGhostManifest as validateProtocol } from '@cindy/plugin-protocol';
import { validateGhostManifest, ghostPermissionItems } from '../ghost.js';

const manifest = {
  schemaVersion: 3,
  minCindyVersion: '0.1.72',
  id: 'routine-test',
  name: 'Routine Test',
  description: 'Local events',
  version: '1.0.0',
  kind: 'chip',
  entry: 'index.html',
  launch: 'resident',
};

describe.each([
  ['desktop', validateGhostManifest],
  ['protocol', validateProtocol],
] as const)('%s routine manifest compatibility', (_name, validate) => {
  it('preserves existing plugins without granting event publishing', () => {
    const result = validate(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.routineEvents).toBeUndefined();
  });
  it('accepts legacy v2 plugins but rejects their v3-only event capability', () => {
    const legacy = { ...manifest, schemaVersion: 2, slots: [] };
    expect(validate(legacy).ok).toBe(true);
    const rejected = validate({
      ...legacy,
      routineEvents: { events: [{ type: 'new', name: 'New', fields: [] }] },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toContain('schemaVersion 3');
  });
  it('roundtrips declared event types and rejects invalid declarations', () => {
    const routineEvents = {
      events: [{ type: 'message.new', name: 'New Message', fields: ['channel'] }],
    };
    const result = validate({ ...manifest, routineEvents });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.routineEvents).toEqual(routineEvents);
    for (const invalid of [
      {},
      { events: [] },
      { events: [routineEvents.events[0], routineEvents.events[0]] },
      { events: [{ type: 'new', name: '', fields: [] }] },
    ])
      expect(validate({ ...manifest, routineEvents: invalid }).ok).toBe(false);
  });
});

it('shows event publishing in the plugin capability description', () => {
  const result = validateGhostManifest({
    ...manifest,
    routineEvents: { events: [{ type: 'new', name: 'New', fields: [] }] },
  });
  if (!result.ok) throw new Error(result.reason);
  expect(ghostPermissionItems(result.manifest).some((item) => item.key === 'routine-events')).toBe(
    true,
  );
});
