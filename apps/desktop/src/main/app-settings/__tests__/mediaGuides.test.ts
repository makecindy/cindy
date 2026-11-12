import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', generation: 1 }));
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../preferences.js', () => ({ manageAppPreferences: vi.fn() }));
vi.mock('../../ownerContext.js', () => ({ activeDataOwnerId: () => 'owner', isOwnerBoundaryPending: () => false,
  ownerScopedPath: (name: string) => path.join(state.root, name) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://metadata.example' }));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: fetch,
  ServerApiError: class extends Error { constructor(readonly code: string, readonly statusCode: number, message: string) { super(message); } } }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
vi.mock('../../cindy-brain/mediaDisplayVisibility.js', () => ({ isCatalogMediaModelVisible: () => true }));
import { ServerApiError } from '../../serverApiClient.desktop.js';
import { configureProviderMediaRuntime } from '../../cindy-media/providerMediaRuntime.js';
import { configureModelSettingsActions, manageAppModels } from '../models.js';

const target = { providerId: 'relay', agent: 'pi' as const, modelId: 'new-image' };
const guide = { schemaVersion: 1, guideId: 'user-media', revision: 'draft', operations: [{
  capability: 'image.generate', request: { method: 'POST', path: '/render', timeoutMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 1024 },
  response: { mode: 'sync', media: [{ path: ['image'], encoding: 'base64', kind: 'image' }] },
  instructions: 'Send prompt.', inputSchema: { type: 'object' }, exampleBody: { prompt: 'cat' },
}] };
const request = { operation: 'mediaGuide' as const, target };

// Unit integration through the real settings entry, resolver and owner-scoped
// disk store: saving a Guide must not call a model or bypass the write guard.
describe('media Guide settings operations', () => {
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-guide-settings-'));
    fetch.mockReset().mockRejectedValue(new ServerApiError('MEDIA_INVOCATION_GUIDE_NOT_FOUND', 404, 'missing'));
    configureProviderMediaRuntime({ listModels: () => [], guideScope: candidate => candidate.providerId === 'relay' && candidate.agent === 'pi' ? 'route-1' : null,
      invoke: async () => { throw new Error('must not generate'); } });
    configureModelSettingsActions({ owner: () => ({ dataOwnerId: 'owner', ownerGeneration: state.generation }),
      list: async () => ({ providers: [{ id: 'relay', models: { pi: [{ id: 'new-image', mode: 'image_generation', modalities: { input: ['text'], output: ['image'] } }] } }] }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);
  });
  afterEach(() => fs.rmSync(state.root, { force: true, recursive: true }));
  // Public definitions are returned unchanged through the pre-existing endpoint;
  // an incompatible path is for the agent to diagnose and override locally.
  it('reads an existing public Guide without requesting a new protocol or rewriting paths', async () => {
    const published = { ...guide, operations: [{ ...guide.operations[0], request: { ...guide.operations[0]!.request,
      path: '/volcengine/api/v3/images/generations' } }] };
    fetch.mockResolvedValueOnce({ modelId: target.modelId, guide: published });
    expect(await manageAppModels({ ...request, change: { action: 'get' } }, async () => {}))
      .toMatchObject({ source: 'official', guide: published });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/model-access/invocation-guide?modelId=new-image&protocol=gateway', expect.any(Object));
  });
  it('retains the existing explicit image protocol without probing a new HTTP projection', async () => {
    configureProviderMediaRuntime({ listModels: () => [], guideScope: () => 'route-1', guideProtocol: () => 'openai',
      invoke: async () => { throw new Error('must not generate'); } });
    fetch.mockResolvedValueOnce({ modelId: target.modelId, guide });
    expect(await manageAppModels({ ...request, change: { action: 'get' } }, async () => {})).toMatchObject({ source: 'official', guide });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/model-access/invocation-guide?modelId=new-image&protocol=openai', expect.any(Object));
  });
  it('gets missing, validates and saves user evidence, then gets custom without a model call', async () => {
    const guard = vi.fn(async () => {});
    expect(await manageAppModels({ ...request, change: { action: 'get' } }, guard)).toMatchObject({ status: 'missing', customRevision: null });
    expect(fs.readdirSync(state.root)).toEqual([]);
    expect(await manageAppModels({ ...request, change: { action: 'validate', guide } }, guard)).toMatchObject({ valid: true });
    const saved = await manageAppModels({ ...request, change: { action: 'save', guide, expectedRevision: null,
      evidence: { kind: 'prompt', reference: 'User provided API example' } } }, guard);
    expect(saved).toMatchObject({ saved: true, verification: 'not_called' });
    fetch.mockClear();
    const result = await manageAppModels({ ...request, change: { action: 'get' } }, guard);
    expect(result).toMatchObject({ status: 'available', source: 'custom', guide: { revision: saved.customRevision } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a stale write and preserves the latest Guide', async () => {
    const guard = async () => {};
    const saved = await manageAppModels({ ...request, change: { action: 'save', guide, expectedRevision: null } }, guard);
    expect(await manageAppModels({ ...request, change: { action: 'save', guide, expectedRevision: null } }, guard)).toMatchObject({ ok: false, errorCode: 'GUIDE_REVISION_CONFLICT' });
    expect(await manageAppModels({ ...request, change: { action: 'get' } }, guard)).toMatchObject({ customRevision: saved.customRevision });
  });
  it('does not persist after authority revocation or for another runtime', async () => {
    let calls = 0;
    const guard = async () => { if (++calls === 3) throw new Error('revoked'); };
    expect(await manageAppModels({ ...request, change: { action: 'save', guide, expectedRevision: null } }, guard)).toMatchObject({ ok: false });
    expect(fs.readdirSync(state.root)).toEqual([]);
    expect(await manageAppModels({ ...request, target: { ...target, agent: 'codex' }, change: { action: 'get' } }, async () => {}))
      .toMatchObject({ ok: false, errorCode: 'MEDIA_DECLARATION_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
