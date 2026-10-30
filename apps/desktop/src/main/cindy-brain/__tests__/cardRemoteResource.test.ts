import { describe, it, expect, vi } from 'vitest';
vi.mock('../cardStoreDb.js', () => ({ getGhostCard: vi.fn(), upsertGhostCard: vi.fn() }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: vi.fn(), isDataOwnerBroadcastScopeCurrent: vi.fn(), tapWindowBroadcast: vi.fn(), getSafeDataOwnerPushStamp: vi.fn() }));
import { createPluginIdentityRemoteProvider, createGhostCardRemoteProvider, projectGhostCardBlocks, projectGhostCardActions, persistGhostCardWithRemoteChange, findGhostForRemotePluginIdentity } from '../cardRemoteResource.js';
import { upsertGhostCard } from '../cardStoreDb.js';
import { isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast } from '../../device-link/broadcast-tap.js';
import { buildAttachmentOssRef } from '@cindy/device-link';
import { renderMailCard } from '../mailCards';
import { parseMailAttachmentUpload } from '../mailAttachmentUpload';
import { configureMailAttachmentHost, prepareMailAttachmentUpload } from '../mailAttachmentUpload';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const uploadFixture = vi.hoisted(() => ({ materialize: vi.fn() }));
const image = `cindy-media://blobs/${'b'.repeat(64)}.png`;
const audio = `cindy-media://blobs/${'c'.repeat(64)}.mp3`;
const request = { ref: { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify(['s', 'c']) }, client: { protocolVersion: 1, primitives: [] } };
const context = { controllerDeviceId: 'phone' };

it('mail imports reuse task attachment cleanup and verify downloaded bytes before provider delivery', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-upload-test-'));
  try {
    const file = path.join(dir, 'plan.pdf'), bytes = Buffer.from('test attachment');
    await fs.writeFile(file, bytes);
    const accepted = vi.fn(), discard = vi.fn(async () => {});
    uploadFixture.materialize.mockResolvedValue({ message: { content: [{ type: 'file', path: file }] },
      cleanupAfterAcceptance: accepted, cleanupBeforeAcceptance: discard });
    const upload = { name: 'plan.pdf', url: buildAttachmentOssRef({ ossKey: 'fixture', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) };
    configureMailAttachmentHost({ writeTempFile: vi.fn(), materializeDirectSendOssAttachments: uploadFixture.materialize });
    const result = await prepareMailAttachmentUpload(upload, 'task');
    expect(uploadFixture.materialize).toHaveBeenCalledWith('task', expect.objectContaining({ type: 'user' }), {});
    expect(result.attachment).toMatchObject({ path: file, filename: 'plan.pdf', bytes: bytes.length });
    result.accepted(); expect(accepted).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled();
    await fs.writeFile(file, 'wrong bytes');
    await expect(prepareMailAttachmentUpload(upload, 'task')).rejects.toThrow('MAIL_ATTACHMENT_INTEGRITY');
    expect(discard).toHaveBeenCalledOnce();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it('projects phone attachment support and rejects local paths, oversized uploads and terminal drafts', async () => {
  const mail = { accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'self@example.test',
    state: 'draft' as const, status: 'Ready', sendLabel: 'Send', fromLabel: 'From', attachments: [],
    fields: [...['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name })),
      { name: 'attachmentItems', label: 'Files', value: '[]', kind: 'mail-attachments' as const }] };
  let html = renderMailCard(mail);
  const dispatch = vi.fn(async () => true);
  const provider = createGhostCardRemoteProvider({
    readCard: async () => ({ sessionId: 's', callId: 'c', ghostId: 'mail', html, v: 2, height: 100 }),
    authorize: async () => {}, captureScope: () => () => true, interactions: { externalLinks: () => false, dispatch },
  });
  const resource = await provider.get!(context, { ...request, client: { protocolVersion: 1, primitives: ['plugin-card-actions', 'plugin-card-forms'] } });
  expect(resource.blocks?.[0].data).toHaveProperty('mailUpload', true);
  const upload = { name: 'plan.pdf', url: buildAttachmentOssRef({ ossKey: 'fixture', size: 100, sha256: 'a'.repeat(64), mimeType: 'application/pdf' }) };
  const values = Object.fromEntries(mail.fields.map(f => [f.name, f.value]));
  const base = { client: request.client, collectionId: 'plugin-results', resourceRef: request.ref, actionId: `mail:attach:${mail.key}`,
    input: { revision: resource.revision, pageId: 'page', mailAttachment: upload, formValues: values } };
  await provider.invoke!(context, base);
  expect(dispatch).toHaveBeenLastCalledWith('c', base.actionId, undefined, 'page', 'mail', 'phone', values, false, upload);
  for (const invalid of [{ ...upload, url: '/private/mail.pdf' }, { ...upload, name: '../secret' },
    { ...upload, url: buildAttachmentOssRef({ ossKey: 'large', size: 17 * 1024 * 1024, sha256: 'a'.repeat(64) }) }]) {
    expect(parseMailAttachmentUpload(invalid)).toBeNull();
    await expect(provider.invoke!(context, { ...base, input: { ...base.input, mailAttachment: invalid } })).rejects.toThrow();
  }
  html = renderMailCard({ ...mail, state: 'deleted' });
  await expect(provider.invoke!(context, base)).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(1);
});

describe('native mobile card actions', () => {
  it('accepts edits across autosave revisions but rejects replaced form identities and forged actions', async () => {
    const fields = JSON.stringify([{ name: 'body', label: 'Message', value: 'Saved' }]).replace(/"/g, '&quot;');
    let html = `<div data-ghost-form="${fields}" data-ghost-change="change:one">Saved</div><button data-ghost-action="send:one" data-ghost-submit="true">Send</button>`;
    const dispatch = vi.fn(async () => true);
    const provider = createGhostCardRemoteProvider({ readCard: async () => ({ sessionId: 's', callId: 'c', ghostId: 'mail', html, v: 2, height: 100 }),
      authorize: async () => {}, captureScope: () => () => true, interactions: { externalLinks: () => false, dispatch } });
    const base = { client: request.client, collectionId: 'plugin-results', resourceRef: request.ref, actionId: 'change:one',
      input: { revision: 'earlier-save', pageId: 'page', formChange: true, formValues: { body: 'Latest' } } };
    await provider.invoke!(context, base);
    expect(dispatch).toHaveBeenLastCalledWith('c', 'change:one', undefined, 'page', 'mail', 'phone', { body: 'Latest' }, true);
    await provider.invoke!(context, { ...base, actionId: 'send:one', input: { ...base.input, formChange: false, formKey: 'change:one' } });
    await expect(provider.invoke!(context, { ...base, actionId: 'forged' })).rejects.toThrow();
    html = html.replaceAll(':one', ':two');
    await expect(provider.invoke!(context, base)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('projects editable fields and rejects old-client, partial and stale submissions', async () => {
    const form = [{ name: 'body', label: 'Message', value: 'Original', multiline: true }];
    const html = `<div data-ghost-form="${JSON.stringify(form).replace(/"/g, '&quot;')}">Original</div><button data-ghost-action="send" data-ghost-submit="true">Send</button>`;
    const dispatch = vi.fn(async () => true);
    const provider = createGhostCardRemoteProvider({ readCard: async () => ({ sessionId: 's', callId: 'c', ghostId: 'mail', html, v: 2, height: 160 }),
      authorize: async () => {}, captureScope: () => () => true, interactions: { externalLinks: () => false, dispatch } });
    const legacy = await provider.get!(context, { ...request, client: { protocolVersion: 1, primitives: ['plugin-card-actions'] } });
    expect(legacy.blocks?.find(block => block.id === 'text')?.fallbackMarkdown).toContain('Original');
    expect(legacy.blocks?.find(block => block.id === 'actions')?.data).toEqual(expect.objectContaining({ items: [expect.objectContaining({ disabled: true })] }));
    const resource = await provider.get!(context, { ...request, client: { protocolVersion: 1, primitives: ['plugin-card-actions', 'plugin-card-forms'] } });
    expect(resource.blocks?.find(block => block.id === 'actions')?.data).toEqual(expect.objectContaining({ form }));
    expect(resource.blocks?.find(block => block.id === 'text')?.fallbackMarkdown).not.toContain('Original');
    const base = { client: request.client, collectionId: 'plugin-results', resourceRef: request.ref, actionId: 'send', input: { revision: resource.revision, pageId: 'page' } };
    for (const values of [undefined, {}, { extra: 'text' }, { body: 'x'.repeat(16001) }])
      await expect(provider.invoke!(context, { ...base, input: { ...base.input, formValues: values } })).rejects.toThrow();
    await provider.invoke!(context, { ...base, input: { ...base.input, formValues: { body: 'Edited' } } });
    expect(dispatch).toHaveBeenCalledWith('c', 'send', undefined, 'page', 'mail', 'phone', { body: 'Edited' });
    await expect(provider.invoke!(context, { ...base, input: { ...base.input, revision: 'old', formValues: { body: 'Edited' } } })).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
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
    expect(dispatch).toHaveBeenCalledWith('c', 'edit', 'Change it', 'page', 'art', 'phone', undefined);
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
  it('resolves explicit root and organization identities, but never guesses an ambiguous legacy id', () => {
    const root = { manifest: { id: 'helper' }, namespace: null, name: 'Root' };
    const org = { manifest: { id: 'helper' }, namespace: 'acme', name: 'Organization' };
    expect(findGhostForRemotePluginIdentity([root, org], JSON.stringify([null, 'helper']))).toBe(root);
    expect(findGhostForRemotePluginIdentity([root, org], JSON.stringify(['acme', 'helper']))).toBe(org);
    expect(findGhostForRemotePluginIdentity([root, org], '_ns__acme__helper')).toBe(org);
    expect(findGhostForRemotePluginIdentity([root, org], '_ns/acme/helper')).toBe(org);
    expect(findGhostForRemotePluginIdentity([root, org], 'helper')).toBeUndefined();
    expect(findGhostForRemotePluginIdentity([org], 'helper')).toBe(org);
    expect(findGhostForRemotePluginIdentity([root, org], JSON.stringify(['other', 'helper']))).toBeUndefined();
    expect(findGhostForRemotePluginIdentity([root, org], '["acme","../helper"]')).toBeUndefined();
  });
  it('projects the requested organization identity through the task-scoped resource', async () => {
    const ghosts = [
      { manifest: { id: 'helper' }, namespace: null, name: 'Root' },
      { manifest: { id: 'helper' }, namespace: 'acme', name: 'Organization' },
    ];
    const provider = createPluginIdentityRemoteProvider({
      readIdentity: (id) => {
        const ghost = findGhostForRemotePluginIdentity(ghosts, id);
        return ghost ? { name: ghost.name } : undefined;
      },
      authorize: async () => {}, captureScope: () => () => true,
    });
    const ref = { ...request.ref, id: JSON.stringify(['s', JSON.stringify(['acme', 'helper'])]) };
    expect((await provider.get!(context, { ...request, ref })).display.title).toBe('Organization');
    await expect(provider.get!(context, { ...request, ref: { ...ref, id: JSON.stringify(['s', 'helper']) } })).rejects.toThrow('Plugin not found');
    const longNamespace = 'a'.repeat(126);
    ghosts.push({ manifest: { id: 'helper' }, namespace: longNamespace, name: 'Long Namespace' });
    const longRef = { ...ref, id: JSON.stringify(['s', JSON.stringify([longNamespace, 'helper'])]) };
    expect((await provider.get!(context, { ...request, ref: longRef })).display.title).toBe('Long Namespace');
  });
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
