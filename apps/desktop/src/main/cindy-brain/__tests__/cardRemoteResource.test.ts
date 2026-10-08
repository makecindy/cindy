import { describe, it, expect, vi } from 'vitest';
vi.mock('../cardStoreDb.js', () => ({ getGhostCard: vi.fn(), upsertGhostCard: vi.fn() }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: vi.fn(), isDataOwnerBroadcastScopeCurrent: vi.fn(), tapWindowBroadcast: vi.fn(), getSafeDataOwnerPushStamp: vi.fn() }));
import { createPluginIdentityRemoteProvider, createGhostCardRemoteProvider, projectGhostCardBlocks, projectGhostCardActions, persistGhostCardWithRemoteChange } from '../cardRemoteResource.js';
import { upsertGhostCard } from '../cardStoreDb.js';
import { isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast } from '../../device-link/broadcast-tap.js';
const image = `cindy-media://blobs/${'b'.repeat(64)}.png`;
const audio = `cindy-media://blobs/${'c'.repeat(64)}.mp3`;
const request = { ref: { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify(['s', 'c']) }, client: { protocolVersion: 1, primitives: [] } };
const context = { controllerDeviceId: 'phone' };

describe('native mobile card actions', () => {
  it('projects declared buttons and approved links, preserving required text input and disabled state', () => {
    const html = '<button data-ghost-action="edit" data-ghost-prompt="Describe &amp; edit">Edit <b>image</b></button><button data-ghost-action="delete" disabled>Delete</button><a data-ghost-link="https://example.com/?a=1&amp;b=2">Visit</a>';
    expect(projectGhostCardActions(html, false)).toEqual([
      { id: 'edit', label: 'Edit image', prompt: 'Describe & edit', disabled: false },
      { id: 'delete', label: 'Delete', disabled: true },
    ]);
    expect(projectGhostCardActions(html, true)[2]).toEqual({ id: 'link:2', label: 'Visit', url: 'https://example.com/?a=1&b=2', disabled: false });
  });
  it('checks the actual persisted card revision and declaration before dispatch, and keeps legacy clients inert', async () => {
    let html = '<button data-ghost-action="edit" data-ghost-prompt="Describe">Edit</button>';
    const dispatch = vi.fn(async () => true);
    const provider = createGhostCardRemoteProvider({
      readCard: async () => ({ sessionId: 's', callId: 'c', ghostId: 'art', html, v: 1, height: 100 }),
      authorize: async () => {}, captureScope: () => () => true,
      interactions: { externalLinks: () => true, dispatch },
    });
    const old = await provider.get!(context, request);
    expect(old.blocks?.some(b => b.primitive === 'plugin-card-actions')).toBe(false);
    const resource = await provider.get!(context, { ...request, client: { protocolVersion: 1, primitives: ['plugin-card-actions'] } });
    const base = { client: request.client, collectionId: 'plugin-results', resourceRef: request.ref, actionId: 'edit', input: { revision: resource.revision, pageId: 'page', prompt: 'Change it' } };
    await expect(provider.invoke!(context, { ...base, actionId: 'forged' })).rejects.toThrow();
    await expect(provider.invoke!(context, { ...base, input: { ...base.input, prompt: '' } })).rejects.toThrow();
    await provider.invoke!(context, base);
    expect(dispatch).toHaveBeenCalledWith('c', 'edit', 'Change it', 'page', 'art', 'phone');
    html = '<p>Changed</p>';
    await expect(provider.invoke!(context, base)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('read-only plugin card projection', () => {
  it('preserves readable text and managed assets, never HTML, styles or executable actions', () => {
    const blocks = projectGhostCardBlocks(`<style>p{color:red}</style><h2>Result &amp; title</h2><p>Done</p><img src="${image}"/><div data-ghost-audio="${audio}"></div><button data-ghost-action="delete">Delete</button><script>secret()</script><img src="file:///secret"/>`);
    expect(blocks[0].fallbackMarkdown).toBe('Result & title\nDone\n\nDelete');
    expect(blocks.filter((b) => b.data).map((b) => b.data)).toEqual([{ url: image }, { url: audio }]);
    expect(JSON.stringify(blocks)).not.toMatch(/<|secret|color:red|data-ghost-action/);
  });
  it('preserves image descriptions and declared destinations as inert text', () => {
    const blocks = projectGhostCardBlocks(`<img src="${image}" alt="A chart"/><a data-ghost-link="https://example.com/?a=1&amp;b=2">Report</a>`);
    expect(blocks[0].fallbackMarkdown).toContain('A chart');
    expect(blocks[0].fallbackMarkdown).toContain('a=1&b=2');
    expect(blocks[0].fallbackMarkdown).toContain('Report');
  });
  it('invalidates only after persistence and with the task boundary', async () => {
    let resolve!: () => void;
    vi.mocked(upsertGhostCard).mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    vi.mocked(isDataOwnerBroadcastScopeCurrent).mockReturnValue(true);
    const write = persistGhostCardWithRemoteChange({ callId: 'c', sessionId: 's', ghostId: 'art', html: '<p>Done</p>', v: 1, height: 100, updatedAt: 1 });
    expect(tapWindowBroadcast).not.toHaveBeenCalled();
    resolve(); await write;
    expect(tapWindowBroadcast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId: 's' }), undefined);
    vi.mocked(tapWindowBroadcast).mockClear();
    vi.mocked(isDataOwnerBroadcastScopeCurrent).mockReturnValue(false);
    await persistGhostCardWithRemoteChange({ callId: 'c', sessionId: 's', ghostId: 'art', html: '<p>Done</p>', v: 1, height: 100, updatedAt: 1 });
    expect(tapWindowBroadcast).not.toHaveBeenCalled();
  });
  it('reads only the requested task card and rechecks access after I/O', async () => {
    const authorize = vi.fn(async () => {});
    const readCard = vi.fn(async () => ({ sessionId: 's', callId: 'c', ghostId: 'art', html: '<p>Done</p>', v: 1, height: 100 }));
    const provider = createGhostCardRemoteProvider({ readCard, authorize, captureScope: () => () => true });
    const result = await provider.get!(context, request);
    expect(result.blocks?.[0].fallbackMarkdown).toBe('Done');
    expect(result).not.toHaveProperty('actions');
    expect(authorize.mock.calls).toEqual([['s'], ['s']]);
    readCard.mockResolvedValue({ sessionId: 'other', callId: 'c', ghostId: 'art', html: '<p>private</p>', v: 1, height: 100 });
    await expect(provider.get!(context, request)).rejects.toThrow('Card does not exist');
  });
  it('rejects hidden tasks, malformed refs, missing cards and late owner changes', async () => {
    const readCard = vi.fn(async () => ({ sessionId: 's', callId: 'c', ghostId: 'art', html: '<p>private</p>', v: 1, height: 100 }));
    const provider = createGhostCardRemoteProvider({ readCard, authorize: async () => {}, captureScope: () => () => false });
    await expect(provider.get!(context, request)).rejects.toThrow('Card does not exist');
    readCard.mockClear();
    await expect(provider.get!(context, { ...request, ref: { ...request.ref, id: 'bad' } })).rejects.toThrow('Card does not exist');
    expect(readCard).not.toHaveBeenCalled();
    const hidden = createGhostCardRemoteProvider({ readCard, authorize: async () => { throw new Error('hidden'); }, captureScope: () => () => true });
    await expect(hidden.get!(context, request)).rejects.toThrow('hidden');
    expect(readCard).not.toHaveBeenCalled();
    const missing = createGhostCardRemoteProvider({ readCard: async () => null, authorize: async () => {}, captureScope: () => () => true });
    await expect(missing.get!(context, request)).rejects.toThrow('Card does not exist');
  });
});


describe('plugin identity for mobile annotations', () => {
  const request = { ref: { collectionId: 'plugin-identities', kind: 'plugin', id: '["s","art"]' }, client: { protocolVersion: 1, primitives: [] } };
  it('projects only public name and bounded raster data, never credentials or local URLs', async () => {
    const readIdentity = vi.fn(() => ({ name: 'Art', iconDataUrl: 'data:image/png;base64,YQ==', secret: 'private' }));
    const authorize = vi.fn(async () => {});
    const provider = createPluginIdentityRemoteProvider({ readIdentity, authorize, captureScope: () => () => true });
    const result = await provider.get!(context, request);
    expect(result.display.title).toBe('Art');
    expect(result.blocks?.[0].data).toEqual({ url: 'data:image/png;base64,YQ==' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(authorize).toHaveBeenCalledWith('s');
    readIdentity.mockReturnValue({ name: 'Art', iconDataUrl: 'file:///private/icon.png', secret: 'private' });
    expect((await provider.get!(context, request)).blocks).toEqual([]);
  });
  it('rejects inaccessible sessions and an account change while authorization awaits', async () => {
    const readIdentity = vi.fn(() => ({ name: 'Art' }));
    const provider = createPluginIdentityRemoteProvider({ readIdentity, authorize: async () => {}, captureScope: () => () => false });
    await expect(provider.get!(context, request)).rejects.toThrow('Plugin not found');
    expect(readIdentity).not.toHaveBeenCalled();
    const denied = createPluginIdentityRemoteProvider({ readIdentity, authorize: async () => { throw new Error('denied'); }, captureScope: () => () => true });
    await expect(denied.get!(context, request)).rejects.toThrow('denied');
    expect(readIdentity).not.toHaveBeenCalled();
  });
});
