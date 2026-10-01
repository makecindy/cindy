import { describe, expect, it, vi } from 'vitest';

import { GhostMediaHandoverTargetTracker } from '../ghostMediaHandoverTargetTracker';
import { resolveGhostPanelMedia } from '../previewGate';

const hash = 'a'.repeat(64);
const uri = 'cindy-ghost://helper/media/' + hash + '.png';

describe('Ghost media handover targets', () => {
  it.each(['media', 'preview'])('keeps same-name root and organization %s drags isolated through a cascade', async (shape) => {
    const tracker = new GhostMediaHandoverTargetTracker();
    const sources = ['helper', '_ns__acme__helper', '_ns__other__helper'];
    const tokens = sources.map((instanceId) => tracker.register({ ghostId: 'helper', instanceId, isCurrent: () => true }));
    expect(new Set(tokens).size).toBe(3);
    const dragUri = 'cindy-ghost://helper/' + shape + '/' + hash + '.png';
    for (const position of [1, 0, 2, 1]) {
      const target = tracker.resolve(tokens[position], dragUri);
      expect(target).toEqual({ ghostId: 'helper', instanceId: sources[position] });
      const ghostCanRead = vi.fn(async (_hash: string, instanceId: string) => instanceId === sources[position]);
      await expect(resolveGhostPanelMedia(dragUri, 'attach', {
        ghostCanRead,
        getBlobInfo: async () => ({ ext: '.png', mimeType: 'image/png' }),
        blobUrl: () => 'cindy-media://blobs/image.png',
        blobAbsPath: () => '/blobs/image.png', statSize: async () => 42,
      }, target!)).resolves.toMatchObject({ kind: 'image' });
      expect(ghostCanRead).toHaveBeenCalledWith(hash, sources[position]);
    }
  });

  it('never grants a sibling instance ledger reference', async () => {
    const tracker = new GhostMediaHandoverTargetTracker();
    const token = tracker.register({ ghostId: 'helper', instanceId: '_ns__acme__helper', isCurrent: () => true });
    const target = tracker.resolve(token, uri);
    const ghostCanRead = vi.fn(async (_hash: string, instanceId: string) => instanceId === 'helper');
    await expect(resolveGhostPanelMedia(uri, 'attach', {
      ghostCanRead,
      getBlobInfo: async () => ({ ext: '.png', mimeType: 'image/png' }),
      blobUrl: () => 'cindy-media://blobs/image.png',
      blobAbsPath: () => '/blobs/image.png', statSize: async () => 42,
    }, target!)).resolves.toBeNull();
    expect(ghostCanRead).toHaveBeenCalledExactlyOnceWith(hash, '_ns__acme__helper');
  });

  it('revokes a detached guest without revoking its same-name sibling', () => {
    const tracker = new GhostMediaHandoverTargetTracker();
    const root = tracker.register({ ghostId: 'helper', instanceId: 'helper', isCurrent: () => true });
    const organization = tracker.register({ ghostId: 'helper', instanceId: '_ns__acme__helper', isCurrent: () => true });
    tracker.revoke(organization);
    expect(tracker.resolve(organization, uri)).toBeNull();
    expect(tracker.resolve(root, uri)?.instanceId).toBe('helper');
  });

  it.each(['owner generation', 'receipt replacement', 'guest destruction', 'host destruction'])('does not revive after %s changes', () => {
    const tracker = new GhostMediaHandoverTargetTracker();
    let current = true;
    const token = tracker.register({ ghostId: 'helper', instanceId: 'helper', isCurrent: () => current });
    current = false;
    expect(tracker.resolve(token, uri)).toBeNull();
    current = true;
    expect(tracker.resolve(token, uri)).toBeNull();
  });

  it('rejects unknown tokens, self-reported instances and another URL host', () => {
    const tracker = new GhostMediaHandoverTargetTracker();
    const token = tracker.register({ ghostId: 'helper', instanceId: '_ns__acme__helper', isCurrent: () => true });
    for (const invalid of [undefined, null, '', '_ns__acme__helper', {}, 'a'.repeat(1024)]) {
      expect(tracker.resolve(invalid, uri)).toBeNull();
    }
    expect(tracker.resolve(token, uri.replace('helper', 'other'))).toBeNull();
    expect(tracker.resolve(token, uri + '?instanceId=helper')).toBeNull();
    expect(tracker.resolve(token, uri)?.instanceId).toBe('_ns__acme__helper');
  });
});
