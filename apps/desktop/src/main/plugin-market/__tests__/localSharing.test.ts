// Test value: the local-share production coordinator must keep one immutable
// package across upload/material retries and require the original signed-in owner.
// Public sharing tests have no upload or owner-bound package session. Minimal
// inputs are one local package, an ambiguous material failure and an owner switch.
// Unit tier: native/filesystem/network boundaries are fake; no real waits or I/O.
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  api: vi.fn(), put: vi.fn(), content: vi.fn(), snapshot: vi.fn(), inspect: vi.fn(), list: vi.fn(),
  mkdir: vi.fn(), write: vi.fn(), open: vi.fn(), remove: vi.fn(),
  auth: vi.fn(), refresh: vi.fn(), download: vi.fn(), install: vi.fn(),
  missing: null as string | null,
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '0.1.200', isPackaged: true } }));
vi.mock('node:fs/promises', () => ({ default: { mkdtemp: io.mkdir, writeFile: io.write, open: io.open, rm: io.remove } }));
vi.mock('../../authManager.js', () => ({ getAuthState: io.auth, getActiveAuthRealm: () => 'global', getAccessToken: () => 'owner-token', refresh: io.refresh }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../clientEndpointsService.js', () => ({ getBuildClientEndpoint: (name: string) => name === io.missing ? null : name === 'shareBaseUrl' ? 'https://share.example.test' : 'https://plugin.example.test' }));
vi.mock('../../cindy-brain/index.js', () => ({ getGhostManager: () => ({ list: io.list, inspect: io.inspect }), installLocalPluginSharePackage: io.install }));
vi.mock('../download.js', () => ({ downloadVerifiedPlugin: io.download }));
vi.mock('../../cindy-brain/exportGhostPackage.js', () => ({ inspectInstalledGhostPackageContent: io.content, snapshotInstalledGhostPackage: io.snapshot }));
vi.mock('../../plugin-publisher/putObject.js', () => ({ putLocalFile: io.put, PluginPublisherPutError: class extends Error {} }));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: io.api, ServerApiError: class extends Error {} }));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: vi.fn() }));
vi.mock('../../lifecycle.js', () => ({ onQuit: vi.fn() }));
vi.mock('../objectUrlPolicy.js', () => ({ pluginObjectUrlOptions: () => undefined }));

import { prepareLocalPluginShare as prepareShare, releaseLocalPluginShare, readLocalPluginShare, installLocalPluginShare } from '../localSharing.js';
import { ghostInstallApprovalToken } from '../../../shared/ghost.js';
import type { ShareContent, ShareOptions } from '../../../shared/share.js';

const operation = 'operation_00000001';
const bytes = Buffer.from('frozen-local-package');
const digest = createHash('sha256').update(bytes).digest('hex');
const manifest = { schemaVersion: 3, id: 'local-example', name: 'Local Example', version: '1.0.0', entry: 'index.js' };
const ghost = { manifest, dir: path.join(os.tmpdir(), 'virtual-local-plugin'), namespace: null, namespaceState: 'confirmed', approval: { state: 'approved' as const, revision: '00000000-0000-4000-8000-000000000001' }, builtin: false, publishingSource: { kind: 'local' } };
const binding = { version: manifest.version, approvalToken: ghostInstallApprovalToken(ghost.approval) };
const prepareLocalPluginShare = async (caller: number, instanceId: string, id: string, options: ShareOptions): Promise<ShareContent> => {
  // Follow the real dialog's check-before-confirm flow. Confirmation must not
  // create a missing operation or choose a new content hash.
  const checked = await prepareShare(caller, instanceId, id, options, binding, false);
  if (!('confirmationRequired' in checked)) return checked;
  const result = await prepareShare(caller, instanceId, id, options, binding, true);
  if ('confirmationRequired' in result) throw new Error('Unexpected upload confirmation');
  return result;
};
let currentOwner = 1;
let signedIn = true;
let failMaterial = false;
const assigned = new Map<string, string>();
const details = (id: string) => ({ schemaVersion: 1, snapshotId: id, ghostId: manifest.id, name: manifest.name, description: null, author: null, version: manifest.version,
  sha256: digest, contentSha256: digest, sizeBytes: bytes.length, createdAt: '2026-10-28T00:00:00.000Z', icon: null });

beforeEach(() => {
  vi.clearAllMocks(); assigned.clear(); currentOwner = 1; signedIn = true; failMaterial = false;
  io.api.mockReset();
  io.missing = null;
  io.auth.mockImplementation(() => ({ ownerGeneration: currentOwner, isAuthenticated: signedIn, mode: 'cloud', user: signedIn ? { id: 'owner', membershipKind: 'personal' } : null }));
  io.list.mockReturnValue([ghost]);
  io.content.mockResolvedValue({ status: 'prepared', ghost, contentSha256: digest });
  io.snapshot.mockResolvedValue({ status: 'prepared', bytes, ghost, contentSha256: digest, shareContentSha256: digest });
  io.mkdir.mockResolvedValue(path.join(os.tmpdir(), 'virtual-local-share'));
  io.write.mockResolvedValue(undefined); io.remove.mockResolvedValue(undefined);
  io.open.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
  io.inspect.mockResolvedValue({ packageSha256: digest, canonicalManifest: manifest });
  io.put.mockResolvedValue({ bytesSent: bytes.length });
  io.download.mockResolvedValue(undefined); io.install.mockResolvedValue(ghost);
  io.api.mockImplementation(async (url: string, options: { body: Record<string, unknown> }) => {
    if (url === '/api/local-plugin-shares/check') return { status: 'upload_required', contentSha256: options.body.contentSha256 };
    if (url === '/api/local-plugin-shares/uploads') {
      const key = String(options.body.operationId);
      if (!assigned.has(key)) assigned.set(key, String.fromCharCode(97 + assigned.size).repeat(32));
      return { snapshotId: assigned.get(key), status: 'uploading', putUrl: 'https://object.example.test/upload',
        headers: { 'Content-Type': 'application/octet-stream', 'x-oss-forbid-overwrite': 'true' }, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    }
    if (url.startsWith('/api/local-plugin-shares/uploads/')) {
      const id = url.split('/')[4]!;
      return { snapshotId: id, status: 'ready', snapshot: details(id), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    }
    if (url === '/api/shares') {
      if (failMaterial) { failMaterial = false; throw new Error('Connection closed'); }
      const id = String(options.body.reference);
      return { schemaVersion: 1, kind: 'local-plugin', snapshot: details(id), includeAttribution: options.body.includeAttribution,
        shareId: id, url: `https://share.example.test/s/${id}`, imageSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
    }
    throw new Error('Unexpected fixture route');
  });
});

// Recipient reads/install must bind the clicked fixed snapshot. Public install
// tests select market releases and cannot cover this independent manual source.
describe('local share recipient', () => {
  const snapshotId = 'z'.repeat(32);
  const ticket = () => ({ ...details(snapshotId), url: 'https://object.example.test/fixed.cindy', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  it('requires login before reading a shared package', async () => {
    signedIn = false;
    await expect(readLocalPluginShare(snapshotId)).rejects.toThrow();
    expect(io.api).not.toHaveBeenCalled();
  });
  it('reads only the requested snapshot and installs the exact bytes through manual consent', async () => {
    io.api.mockResolvedValueOnce(details(snapshotId)).mockResolvedValueOnce(ticket());
    const snapshot = await readLocalPluginShare(snapshotId);
    expect(snapshot.version).toBe('1.0.0');
    const prompt = vi.fn();
    await expect(installLocalPluginShare(snapshotId, snapshot, prompt)).resolves.toBe(ghost);
    expect(io.download.mock.calls[0]?.slice(0, 2)).toEqual(['https://object.example.test/fixed.cindy', { sha256: digest, sizeBytes: bytes.length }]);
    expect(io.install.mock.calls[0]?.[1]).toMatchObject({ ghostId: manifest.id, version: '1.0.0', sha256: digest, prompt });
    expect(io.remove).toHaveBeenCalled();
  });
  it('rejects a changed download ticket before downloading another version', async () => {
    io.api.mockResolvedValue({ ...ticket(), version: '1.1.0' });
    await expect(installLocalPluginShare(snapshotId, details(snapshotId), vi.fn())).rejects.toThrow();
    expect(io.download).not.toHaveBeenCalled();
    expect(io.install).not.toHaveBeenCalled();
  });
  it('does not install after the owner changes during download and cleans up failures', async () => {
    io.api.mockResolvedValue(ticket());
    io.download.mockImplementation(async () => { currentOwner++; });
    await expect(installLocalPluginShare(snapshotId, details(snapshotId), vi.fn())).rejects.toThrow();
    expect(io.install).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalled();
  });
  it('stops before placement when the selected remote device request is cancelled during download', async () => {
    io.api.mockResolvedValue(ticket());
    let active = true;
    io.download.mockImplementation(async () => { active = false; });
    const assertScope = () => { if (!active) throw { code: 'MUTATION_CANCELLED' }; };
    await expect(installLocalPluginShare(snapshotId, details(snapshotId), vi.fn(), assertScope))
      .rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
    expect(io.install).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalled();
  });
  it('keeps the peer cancellation guard in the original installer transaction', async () => {
    io.api.mockResolvedValue(ticket());
    let active = true;
    const assertScope = () => { if (!active) throw { code: 'MUTATION_CANCELLED' }; };
    io.install.mockImplementation(async (_file, options) => {
      active = false;
      options.assertCurrent();
      return ghost;
    });
    await expect(installLocalPluginShare(snapshotId, details(snapshotId), vi.fn(), assertScope))
      .rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
  });
});

afterEach(async () => {
  await releaseLocalPluginShare(1, operation);
  await releaseLocalPluginShare(1, 'operation_00000002');
});

describe('local plugin sharing coordinator', () => {
  it('asks before a new upload, then reuses unchanged bytes without confirmation for a new share', async () => {
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false))
      .resolves.toEqual({ confirmationRequired: true });
    expect(io.put).not.toHaveBeenCalled();
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.api.mock.calls.some(([url]) => url === '/api/shares' || url.endsWith('/commit'))).toBe(false);
    const first = await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false });
    expect(io.put).toHaveBeenCalledOnce();
    expect(io.snapshot).toHaveBeenCalledOnce();
    const snapshotId = 'b'.repeat(32);
    io.api.mockResolvedValueOnce({ status: 'ready', contentSha256: digest, snapshot: details(snapshotId) });
    const second = await prepareShare(1, 'local-example', 'operation_00000002', { includeAttribution: false }, binding, false);
    expect(second).not.toHaveProperty('confirmationRequired');
    expect(second).toHaveProperty('url', `https://share.example.test/s/${snapshotId}`);
    expect(second).not.toEqual(first);
    expect(io.put).toHaveBeenCalledOnce();
    expect(io.snapshot).toHaveBeenCalledOnce();
  });

  it('requires confirmation again when package bytes change without a version change', async () => {
    await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false });
    const changed = Buffer.from('changed-local-package');
    const changedDigest = createHash('sha256').update(changed).digest('hex');
    io.content.mockResolvedValue({ status: 'prepared', ghost, contentSha256: changedDigest });
    io.snapshot.mockResolvedValue({ status: 'prepared', bytes: changed, ghost, contentSha256: changedDigest, shareContentSha256: changedDigest });
    io.inspect.mockResolvedValue({ packageSha256: changedDigest, canonicalManifest: manifest });
    await expect(prepareShare(1, 'local-example', 'operation_00000002', { includeAttribution: false }, binding, false))
      .resolves.toEqual({ confirmationRequired: true });
    expect(io.api.mock.calls.filter(([url]) => url === '/api/local-plugin-shares/check').at(-1)?.[1].body)
      .toMatchObject({ contentSha256: changedDigest });
    expect(io.api.mock.calls.filter(([url]) => url === '/api/local-plugin-shares/uploads')).toHaveLength(1);
    expect(io.put).toHaveBeenCalledOnce();
  });

  it.each(['pluginApiBaseUrl', 'shareBaseUrl'])('rejects missing %s before reading package bytes', async endpoint => {
    io.missing = endpoint;
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false })).rejects.toMatchObject({ code: 'SHARE_NOT_CONFIGURED' });
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.content).not.toHaveBeenCalled();
    expect(io.put).not.toHaveBeenCalled();
  });
  it('requires login before reading package bytes, even with attribution disabled', async () => {
    signedIn = false;
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false })).rejects.toThrow();
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.content).not.toHaveBeenCalled();
    expect(io.api).not.toHaveBeenCalled();
  });

  it('creates independent uploads for new operations and sends login credentials without attribution', async () => {
    const first = await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false });
    const second = await prepareLocalPluginShare(1, 'local-example', 'operation_00000002', { includeAttribution: false });
    expect(second.url).not.toBe(first.url);
    expect(io.put).toHaveBeenCalledTimes(2);
    for (const [, options] of io.api.mock.calls) expect(options.token).toBe('owner-token');
    expect(io.api.mock.calls.filter(([url]) => url === '/api/shares')[0]![1].body).toMatchObject({ kind: 'local-plugin', includeAttribution: false, authRealm: 'global' });
  });

  // The server may return ready on prepare after dedup; previous fixtures only
  // covered uploading. A new operation must still create its own share material.
  it('creates an independent share without another PUT when prepare reuses the same package', async () => {
    const first = await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false });
    const snapshotId = 'b'.repeat(32);
    io.api.mockResolvedValueOnce({ status: 'upload_required', contentSha256: digest })
      .mockResolvedValueOnce({ snapshotId, status: 'ready', snapshot: details(snapshotId), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const second = await prepareLocalPluginShare(1, 'local-example', 'operation_00000002', { includeAttribution: false });
    expect(second.url).not.toBe(first.url);
    expect(second.url).toContain(snapshotId);
    expect(io.put).toHaveBeenCalledOnce();
    expect(io.api.mock.calls.filter(([url]) => url.endsWith('/commit'))).toHaveLength(1);
    expect(io.api.mock.calls.filter(([url]) => url === '/api/shares')).toHaveLength(2);
  });

  it('rejects a reused snapshot for content other than the checked local package', async () => {
    const snapshotId = 'b'.repeat(32);
    io.api.mockResolvedValueOnce({ status: 'upload_required', contentSha256: digest })
      .mockResolvedValueOnce({ snapshotId, status: 'ready', snapshot: { ...details(snapshotId), contentSha256: '0'.repeat(64) }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    // The public coordinator sanitizes upload/binding failures as SHARE_READ_FAILED.
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false }))
      .rejects.toMatchObject({ code: 'SHARE_READ_FAILED' });
    expect(io.put).not.toHaveBeenCalled();
    expect(io.api.mock.calls.filter(([url]) => url === '/api/shares')).toHaveLength(0);
  });

  // The server can retain a different ZIP encoding of identical verified content.
  // Its selected ZIP must then stay fixed across material and attribution retries.
  it('accepts the retained ZIP for checked content and rejects later ZIP drift', async () => {
    const respond = io.api.getMockImplementation()!;
    let retainedSha = '1'.repeat(64);
    io.api.mockImplementation(async (url: string, options: { body: Record<string, unknown> }) => {
      const result = await respond(url, options);
      return result.snapshot ? { ...result, snapshot: { ...result.snapshot, sha256: retainedSha, sizeBytes: bytes.length + 3 } } : result;
    });
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false }))
      .resolves.toHaveProperty('title', manifest.name);
    expect(io.put).toHaveBeenCalledOnce();
    retainedSha = '2'.repeat(64);
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: true }))
      .rejects.toMatchObject({ code: 'SHARE_READ_FAILED' });
    expect(io.put).toHaveBeenCalledOnce();
    expect(io.snapshot).toHaveBeenCalledOnce();
  });

  it('reuses the exact uploaded snapshot when sharing material fails or attribution changes', async () => {
    failMaterial = true;
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false })).rejects.toThrow();
    io.snapshot.mockResolvedValue({ status: 'prepared', bytes: Buffer.from('later local edits'), ghost, contentSha256: 'changed' });
    const restored = await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false });
    const signed = await prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: true });
    expect(restored.title).toBe('Local Example');
    expect(signed.url).toBe(restored.url);
    expect(io.snapshot).toHaveBeenCalledOnce();
    expect(io.put).toHaveBeenCalledOnce();
    expect(io.api.mock.calls.filter(([url]) => url === '/api/local-plugin-shares/uploads')).toHaveLength(1);
  });

  it('does not continue an old prepared operation after the active owner changes', async () => {
    failMaterial = true;
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false })).rejects.toThrow();
    currentOwner = 2;
    io.api.mockClear();
    await expect(prepareLocalPluginShare(1, 'local-example', operation, { includeAttribution: false })).rejects.toThrow();
    expect(io.api).not.toHaveBeenCalled();
  });

  it('rejects a stale clicked installation before reading its replacement package', async () => {
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, { ...binding, version: '0.9.0' }, false)).rejects.toThrow();
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.content).not.toHaveBeenCalled();
    expect(io.api).not.toHaveBeenCalled();
  });

  // Content lookup must settle before archive work; earlier tests only mocked a
  // ready ZIP upload. These unit inputs distinguish fast reuse, a changed package
  // during consent, lookup failure and owner change while reading the content.
  it('uses a verified content hit without compressing, inspecting or writing an archive', async () => {
    const snapshotId = 'c'.repeat(32);
    const snapshot = { ...details(snapshotId), sha256: '1'.repeat(64) };
    io.api.mockResolvedValueOnce({ status: 'ready', contentSha256: digest,
      snapshot }).mockResolvedValueOnce({ schemaVersion: 1, kind: 'local-plugin', snapshot, includeAttribution: false,
        shareId: snapshotId, url: `https://share.example.test/s/${snapshotId}`, imageSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    const result = await prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false);
    expect(result).toHaveProperty('url', `https://share.example.test/s/${snapshotId}`);
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.inspect).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.put).not.toHaveBeenCalled();
  });

  it('does not upload content that changed while the confirmation was open', async () => {
    await prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false);
    const changedBytes = Buffer.from('changed');
    io.snapshot.mockResolvedValue({ status: 'prepared', bytes: changedBytes, ghost, shareContentSha256: '0'.repeat(64) });
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, true))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // A later attribution request still carries the old confirmation. It must
    // not turn the invalidated operation into a new upload of changed content.
    io.content.mockResolvedValue({ status: 'prepared', ghost, contentSha256: '0'.repeat(64) });
    io.inspect.mockResolvedValue({ packageSha256: createHash('sha256').update(changedBytes).digest('hex'), canonicalManifest: manifest });
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: true }, binding, true))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(io.content).toHaveBeenCalledOnce();
    expect(io.put).not.toHaveBeenCalled();
    expect(io.api.mock.calls.some(([url]) => url === '/api/local-plugin-shares/uploads')).toBe(false);
  });

  // Regression: version/approval changes during consent used to surface as a
  // retryable material failure (or OWNER_CHANGED for a refreshed binding).
  // Existing content-change coverage only changed the archive hash. These unit
  // inputs exercise the production coordinator before any replacement upload.
  it.each([
    { field: 'version', refreshed: false },
    { field: 'version', refreshed: true },
    { field: 'approval', refreshed: false },
    { field: 'approval', refreshed: true },
  ])('requires reopening after $field changes with refreshed binding=$refreshed', async ({ field, refreshed }) => {
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false))
      .resolves.toEqual({ confirmationRequired: true });
    const changedGhost = {
      ...ghost,
      manifest: { ...manifest, version: field === 'version' ? '1.1.0' : manifest.version },
      approval: { ...ghost.approval, revision: field === 'approval' ? '00000000-0000-4000-8000-000000000002' : ghost.approval.revision },
    };
    io.list.mockReturnValue([changedGhost]);
    const nextBinding = { version: changedGhost.manifest.version, approvalToken: ghostInstallApprovalToken(changedGhost.approval) };
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, refreshed ? nextBinding : binding, true))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.put).not.toHaveBeenCalled();
    expect(io.api.mock.calls.some(([url]) => url === '/api/local-plugin-shares/uploads')).toBe(false);
    await releaseLocalPluginShare(1, operation);
    await expect(prepareShare(1, 'local-example', 'operation_00000002', { includeAttribution: false }, nextBinding, false))
      .resolves.toEqual({ confirmationRequired: true });
    expect(io.content).toHaveBeenCalledTimes(2);
  });

  it('requires reopening if the installation changes while the confirmed package is inspected', async () => {
    await prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false);
    io.inspect.mockImplementationOnce(async () => {
      io.list.mockReturnValue([{ ...ghost, approval: { ...ghost.approval, revision: '00000000-0000-4000-8000-000000000002' } }]);
      return { packageSha256: digest, canonicalManifest: manifest };
    });
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, true))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(io.put).not.toHaveBeenCalled();
    expect(io.api.mock.calls.some(([url]) => url === '/api/local-plugin-shares/uploads')).toBe(false);
    expect(io.remove).toHaveBeenCalled();
  });

  it('keeps lookup failure retryable without compressing or uploading', async () => {
    io.api.mockRejectedValueOnce(new Error('Lookup timed out'));
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false)).rejects.toThrow();
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.put).not.toHaveBeenCalled();
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false))
      .resolves.toEqual({ confirmationRequired: true });
  });

  // The real coordinator must reject stale consent before any new content read
  // or upload. Existing changed-content tests retained the operation in memory;
  // a missing record or the production 30-minute expiry loses that binding.
  it.each(['missing', 'expired'])('requires reopening after a %s confirmation record', async state => {
    vi.useFakeTimers();
    try {
      if (state === 'expired') {
        await prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
      }
      const reads = io.content.mock.calls.length;
      const requests = io.api.mock.calls.length;
      const changed = Buffer.from('later local content');
      io.content.mockResolvedValue({ status: 'prepared', ghost, contentSha256: '0'.repeat(64) });
      io.snapshot.mockResolvedValue({ status: 'prepared', bytes: changed, ghost, shareContentSha256: '0'.repeat(64) });
      io.inspect.mockResolvedValue({ packageSha256: createHash('sha256').update(changed).digest('hex'), canonicalManifest: manifest });
      await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, true))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(io.content).toHaveBeenCalledTimes(reads);
      expect(io.api).toHaveBeenCalledTimes(requests);
      expect(io.put).not.toHaveBeenCalled();
      await expect(prepareShare(1, 'local-example', 'operation_00000002', { includeAttribution: false }, binding, false))
        .resolves.toEqual({ confirmationRequired: true });
    } finally { vi.useRealTimers(); }
  });

  it('stops before lookup when the owner changes during content reading', async () => {
    io.content.mockImplementation(async () => { currentOwner++; return { status: 'prepared', ghost, contentSha256: digest }; });
    await expect(prepareShare(1, 'local-example', operation, { includeAttribution: false }, binding, false)).rejects.toThrow();
    expect(io.api).not.toHaveBeenCalled();
    expect(io.snapshot).not.toHaveBeenCalled();
  });
});
