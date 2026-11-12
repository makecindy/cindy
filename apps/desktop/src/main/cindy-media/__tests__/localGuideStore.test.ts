import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGuideStore } from '../localGuideStore.js';
import type { MediaInvocationGuide } from '../../../shared/mediaInvocation.js';
const target = { providerId: 'relay', agent: 'pi' as const, modelId: 'unknown' };
const guide: MediaInvocationGuide = { schemaVersion: 1, guideId: 'private', revision: 'draft', operations: [{
  capability: 'image.generate', request: { method: 'POST', path: '/render', timeoutMs: 1000, maxRequestBytes: 1024, maxResponseBytes: 1024 },
  response: { mode: 'sync', media: [{ path: ['image'], encoding: 'base64', kind: 'image' }] },
  instructions: 'Send prompt.', exampleBody: { prompt: 'cat' }, inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
}] };
// Unit with isolated disk: reads never create defaults; failed/stale writes retain
// the prior Guide and identities cannot cross owner, runtime or endpoint scopes.
describe('local media Guides', () => {
  let folder: string;
  beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-guides-')); });
  afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });
  it('does not write on missing reads and reads a saved Guide immediately', () => {
    const file = path.join(folder, 'a', 'guides.json');
    const store = createLocalGuideStore(() => file);
    expect(store.read(target, 'endpoint-1')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    const saved = store.save(target, 'endpoint-1', guide, null, { kind: 'prompt', reference: 'User supplied example' });
    expect(store.read(target, 'endpoint-1')).toEqual(saved);
    expect(saved.guide.revision).not.toBe('draft');
  });
  it('rejects stale or invalid saves without replacing the existing definition', () => {
    const store = createLocalGuideStore(() => path.join(folder, 'guides.json'));
    const saved = store.save(target, 'endpoint-1', guide, null);
    expect(() => store.save(target, 'endpoint-1', guide, null)).toThrow('GUIDE_REVISION_CONFLICT');
    expect(() => store.save(target, 'endpoint-1', { ...guide, operations: [] }, saved.guide.revision)).toThrow('GUIDE_INVALID');
    expect(store.read(target, 'endpoint-1')).toEqual(saved);
  });
  it('isolates endpoints, runtimes and the active owner path', () => {
    let owner = 'one';
    const store = createLocalGuideStore(() => path.join(folder, owner, 'guides.json'));
    store.save(target, 'endpoint-1', guide, null);
    expect(store.read(target, 'endpoint-2')).toBeNull();
    expect(store.read({ ...target, agent: 'codex' }, 'endpoint-1')).toBeNull();
    owner = 'two';
    expect(store.read(target, 'endpoint-1')).toBeNull();
    owner = 'one';
    expect(store.read(target, 'endpoint-1')).not.toBeNull();
  });
  it('reads a surviving atomic backup without writes and preserves its siblings on save', () => {
    const file = path.join(folder, 'guides.json');
    const store = createLocalGuideStore(() => file);
    const saved = store.save(target, 'endpoint-1', guide, null);
    fs.renameSync(file, `${file}.bak`);
    expect(store.read(target, 'endpoint-1')).toEqual(saved);
    expect(fs.existsSync(file)).toBe(false);
    store.save({ ...target, modelId: 'other' }, 'endpoint-1', guide, null);
    expect(store.read(target, 'endpoint-1')).toEqual(saved);
  });
});
