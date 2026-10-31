import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import { ghostInstallApprovalToken } from '../../../shared/ghost';
import { createIpcError } from '../../../shared/ipc-errors';
import type {
  ContributionOperation,
  SubmissionView,
} from '../../../shared/pluginContributionContract';
import { releasePreparedContribution, type PreparedEntry } from '../prepared';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { PluginMarketLedger } from '../../plugin-market/ledger';

const harness = vi.hoisted(() => ({
  owner: 'A:1',
  root: '',
  entry: null as PreparedEntry | null,
  ghosts: [] as InstalledGhost[],
  passive: false,
  packaged: false,
  evidence: vi.fn(),
  readAvailable: vi.fn(),
  pluginEndpoint: 'https://plugin.test',
  preflight: vi.fn(),
  verifyContent: vi.fn(),
  readInstallation: vi.fn(),
  snapshot: vi.fn(),
  prepare: vi.fn(),
  operation: vi.fn(),
  commit: vi.fn(),
  changes: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  releases: vi.fn(),
  history: vi.fn(),
  put: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => harness.root, get isPackaged() { return harness.packaged; } } }));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpoint: () => harness.pluginEndpoint }));
vi.mock('../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(harness.root, ...parts),
}));
vi.mock('../../authManager', () => ({
  onAuthStateChange: vi.fn(),
  isPassiveSharedUserDataInstance: () => harness.passive,
}));
vi.mock('../../serverApiClient', () => ({
  ServerApiError: class extends Error {
    statusCode = 500;
    code = 'INTERNAL';
  },
}));
vi.mock('../../lifecycle', () => ({ onQuit: vi.fn() }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../cindy-brain/index', () => ({
  getGhostManager: () => ({
    list: () => harness.ghosts,
    approvedInstallEvidence: harness.evidence,
    assertContributionReadAvailable: harness.readAvailable,
  }),
}));
vi.mock('../../plugin-publisher/putObject', () => ({
  putLocalFile: (...args: unknown[]) => harness.put(...args),
}));
vi.mock('../prepared', () => ({
  contributionOwnerKey: () => harness.owner,
  contributionAccountKey: () => harness.owner.split(':')[0],
  assertContributionOwner: (owner: string) => {
    if (owner !== harness.owner) throw new Error('[OWNER_CHANGED] changed');
  },
  assertPreparedInstallation: (entry: PreparedEntry) => {
    const { source } = harness.readInstallation(entry.summary.instanceId, {
      directory: entry.installationDir, approvalToken: entry.approvalToken,
    });
    if (JSON.stringify(source) !== entry.publishingSourceKey)
      throw createIpcError('PRECONDITION_FAILED', 'Publishing source changed');
  },
  assertPreparedContent: harness.verifyContent,
  readContributionInstallation: harness.readInstallation,
  prepareInstalledContribution: harness.snapshot,
  getPreparedContribution: () => harness.entry!,
  releasePreparedContribution: vi.fn(async () => undefined),
}));
vi.mock('../api', () => ({
  ContributionApi: class {
    constructor(private readonly guard?: () => Promise<void>) {}
    readonly owner = harness.owner;
    preflight = harness.preflight;
    prepare = async (...args: unknown[]) => { await this.guard?.(); return harness.prepare(...args); };
    operation = harness.operation;
    commit = async (...args: unknown[]) => { await this.guard?.(); return harness.commit(...args); };
    changes = harness.changes;
    list = harness.list;
    detail = harness.detail;
    releases = harness.releases;
    history = harness.history;
  },
}));

const at = '2026-10-15T00:00:00.000Z';
const subject = { authority: 'https://issuer.test', membershipId: 'member-A' };
const bytes = Buffer.from('the exact package uploaded before a lost response');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const revision = { releaseId: 'release-1', sha256: 'b'.repeat(64), displayUpdatedAt: at };
function submission(): SubmissionView {
  return {
    submissionId: 'submission-1',
    releaseId: 'release-1',
    version: '1.0.0',
    submittedAt: at,
    publishSource: 'community_upload',
    source: 'manual',
    revision,
    revisionState: 'current',
    reviewStatus: 'pending',
    decidedAt: null,
    reason: null,
  };
}
function operation(status: ContributionOperation['status']): ContributionOperation {
  return {
    subject,
    operationId: 'operation-1',
    status,
    createdAt: at,
    updatedAt: at,
    expiresAt: '2099-10-15T00:00:00.000Z',
    failure: null,
    receipt:
      status === 'succeeded'
        ? {
            operationId: 'operation-1',
            submissionId: 'submission-1',
            pluginId: 'canonical-plugin',
            releaseId: 'release-1',
            ghostId: 'hello',
            version: '1.0.0',
            source: 'manual',
            submittedAt: at,
            uploadedPackage: { sha256: sha, sizeBytes: bytes.length },
            releaseRevision: revision,
            outcome: 'metadata_updated',
          }
        : null,
    submission: status === 'succeeded' ? submission() : null,
  };
}
function uploadResponse() {
  return {
    ...operation('awaiting_upload'),
    upload: {
      putUrl: 'https://storage.test/upload',
      headers: {},
      expiresAt: '2099-10-15T00:00:00.000Z',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ownPlugin() {
  return { pluginId: 'canonical-plugin', ghostId: 'hello', namespace: null, name: 'Hello', icon: null,
    updatedAt: at, market: { available: false, unavailableReason: 'not_listed', currentRelease: null },
    latestSubmission: null, actions: { canSubmit: true, canViewMarket: false } };
}
function ownDetail() {
  return { plugin: ownPlugin(), latestSubmissionContent: null, queriedAt: at,
    history: { events: [], nextCursor: null } };
}
import * as host from '../host';
let testGeneration = 0;
beforeEach(async () => {
  vi.resetAllMocks();
  testGeneration++;
  harness.owner = `A:${testGeneration}:1`;
  harness.passive = false;
  harness.packaged = false;
  harness.pluginEndpoint = 'https://plugin.test';
  harness.evidence.mockReturnValue(null);
  harness.root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-contribution-test-'));
  const directory = await fsp.mkdtemp(path.join(harness.root, 'cindy-contribution-'));
  await fsp.writeFile(path.join(directory, 'plugin.cindy'), bytes);
  const ghost: InstalledGhost = {
    manifest: {
      schemaVersion: 2,
      id: 'hello',
      name: 'Hello',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
    },
    dir: path.join(harness.root, 'installed'),
    enabled: true,
    namespace: null,
    publishingSource: { kind: 'local', source: 'manual' },
    namespaceState: 'confirmed',
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
  harness.ghosts = [ghost];
  harness.readInstallation.mockImplementation((instanceId: string, expected?: { directory: string; approvalToken: string }) => {
    const installed = harness.ghosts.find(item => installedGhostStoragePart(item) === instanceId);
    if (!installed) throw createIpcError('NOT_FOUND', 'Installed plugin not found');
    if (expected && (installed.dir !== expected.directory ||
      ghostInstallApprovalToken(installed.approval) !== expected.approvalToken))
      throw createIpcError('PRECONDITION_FAILED', 'Installed plugin changed');
    return { ghost: installed, source: installed.publishingSource };
  });
  harness.entry = {
    owner: harness.owner,
    directory,
    filePath: path.join(directory, 'plugin.cindy'),
    approvalToken: ghostInstallApprovalToken(ghost.approval),
    installationDir: ghost.dir,
    publishingSourceKey: JSON.stringify(ghost.publishingSource),
    pinned: false,
    contentSha256: sha,
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    expiresAt: Date.now() + 60_000,
    summary: {
      preparedId: 'prepared-1',
      instanceId: 'hello',
      pluginId: null,
      ghostId: 'hello',
      name: 'Hello',
      description: '',
      releaseNotes: 'Initial local test functionality',
      version: '1.0.0',
      sha256: sha,
      sizeBytes: bytes.length,
      expiresAt: '2099-10-15T00:00:00.000Z',
    },
  };
  harness.snapshot.mockImplementation(async () => harness.entry!.summary);
  harness.detail.mockResolvedValue(ownDetail());
  harness.preflight.mockResolvedValue({ subject, queriedAt: at, policyVersion: 2, target: { pluginId: null, ghostId: 'hello', version: '1.0.0', expectedRelease: null }, pendingRelease: null, blockers: [], actions: { canSubmit: true } });
  harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 1 });
  harness.list.mockResolvedValue({ plugins: [], nextCursor: null });
  harness.prepare.mockResolvedValue(uploadResponse());
  harness.commit.mockResolvedValue({ subject, operationId: 'operation-1', status: 'validating' });
  harness.operation.mockResolvedValue(operation('succeeded'));
  harness.put.mockImplementation(async (handle: fsp.FileHandle) => {
    const result = Buffer.alloc(bytes.length);
    await handle.read(result, 0, result.length, 0);
    expect(result).toEqual(bytes);
  });
});
afterEach(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true });
});

describe('community submission', () => {
  it('rejects an official market target despite a current submission grant, before reading bytes', async () => {
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'canonical-plugin' };
    harness.detail.mockResolvedValue({ ...ownDetail(), plugin: { ...ownPlugin(), publisherKind: 'official' } });
    await expect(host.prepareContribution('hello', 'manual')).rejects.toThrow('OFFICIAL_PLUGIN_GITHUB_REQUIRED');
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it('rejects a local copy resolved to an official target by preflight', async () => {
    harness.preflight.mockResolvedValueOnce({ ...(await harness.preflight()), target: {
      pluginId: 'canonical-plugin', ghostId: 'hello', version: '1.0.0', expectedRelease: null } });
    harness.detail.mockResolvedValue({ ...ownDetail(), plugin: { ...ownPlugin(), publisherKind: 'official' } });
    await expect(host.prepareContribution('hello', 'ai')).rejects.toThrow('OFFICIAL_PLUGIN_GITHUB_REQUIRED');
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
  });
  it('keeps third-party public targets with a current grant available for preparation', async () => {
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'canonical-plugin' };
    harness.entry!.publishingSourceKey = JSON.stringify(harness.ghosts[0].publishingSource);
    harness.preflight.mockResolvedValueOnce({ ...(await harness.preflight()), target: {
      pluginId: 'canonical-plugin', ghostId: 'hello', version: '1.0.0', expectedRelease: null } });
    harness.detail.mockResolvedValue({ ...ownDetail(), plugin: { ...ownPlugin(), publisherKind: 'personal' } });
    expect(await host.prepareContribution('hello', 'manual')).toMatchObject({ preflight: { actions: { canSubmit: true } } });
    expect(harness.snapshot).toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it('does not read downloaded package bytes when detail visibility lacks publishing ACL', async () => {
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'canonical-plugin' };
    harness.detail.mockResolvedValue({ plugin: { pluginId: 'canonical-plugin', actions: { canSubmit: false } } });
    await expect(host.prepareContribution('hello', 'ai')).rejects.toThrow('Publishing permission required');
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it.each(['127.0.0.1', 'localhost', '[::1]'])('allows the configured %s dev-local adapter on its exact origin', async (hostname) => {
    harness.pluginEndpoint = `http://${hostname}:43340`;
    const response = uploadResponse();
    response.upload.putUrl = `${harness.pluginEndpoint}/dev-local/member-upload?key=test&storageId=memory`;
    harness.prepare.mockResolvedValueOnce(response);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1').stage).toBe('complete'));
    expect(harness.put).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ putUrl: response.upload.putUrl }));
  });

  it.each([
    { label: 'remote HTTP endpoint', endpoint: 'http://plugin.example.test:43340', url: 'http://plugin.example.test:43340/dev-local/member-upload' },
    { label: 'HTTPS configuration', endpoint: 'https://plugin.test', url: 'http://127.0.0.1:43340/dev-local/member-upload' },
    { label: 'another local port', endpoint: 'http://127.0.0.1:43340', url: 'http://127.0.0.1:43341/dev-local/member-upload' },
    { label: 'another local path', endpoint: 'http://127.0.0.1:43340', url: 'http://127.0.0.1:43340/other-upload' },
    { label: 'userinfo', endpoint: 'http://127.0.0.1:43340', url: 'http://user:secret@127.0.0.1:43340/dev-local/member-upload' },
    { label: 'packaged application', endpoint: 'http://127.0.0.1:43340', url: 'http://127.0.0.1:43340/dev-local/member-upload', packaged: true },
    { label: 'a loopback-looking DNS name', endpoint: 'http://127.evil.test:43340', url: 'http://127.evil.test:43340/dev-local/member-upload' },
  ])('refuses $label before sending any package bytes', async ({ endpoint, url, packaged }) => {
    harness.pluginEndpoint = endpoint;
    harness.packaged = packaged ?? false;
    const response = uploadResponse();
    response.upload.putUrl = url;
    harness.prepare.mockResolvedValueOnce(response);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1')).toMatchObject({ stage: 'complete', errorCode: 'PRECONDITION_FAILED' }));
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it.each(['Authorization', 'Proxy-Authorization', 'Cookie'])('refuses the sensitive %s header even on the exact dev-local origin', async (header) => {
    harness.pluginEndpoint = 'http://127.0.0.1:43340';
    const response = uploadResponse();
    response.upload.putUrl = `${harness.pluginEndpoint}/dev-local/member-upload`;
    response.upload.headers = { [header]: 'not-a-real-credential' };
    harness.prepare.mockResolvedValueOnce(response);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1')).toMatchObject({ stage: 'complete', errorCode: 'PRECONDITION_FAILED' }));
    expect(harness.put).not.toHaveBeenCalled();
  });

  it('keeps 202 as processing without inventing a pending submission', async () => {
    const query = deferred<ContributionOperation>();
    harness.operation.mockImplementationOnce(() => query.promise);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(harness.operation).toHaveBeenCalledTimes(1));
    const result = host.contributionTransferStatus('prepared-1');
    expect(result.stage).toBe('processing');
    expect(result.operation?.receipt).toBeNull();
    expect(result.operation?.submission).toBeNull();
    expect(harness.ghosts[0].publishingSource).toEqual({ kind: 'local', source: 'manual' });
    query.resolve(operation('succeeded'));
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1').stage).toBe('complete'));
    expect(host.contributionTransferStatus('prepared-1').stage).toBe('complete');
  });

  // Unit regressions through prepare/submit/status: removing upload recovery must
  // preserve owner/ACL guards and prevent a lost commit from submitting twice.
  function pendingRows(): unknown[] {
    const dir = path.join(harness.root, 'plugin-contributions');
    const file = fs.existsSync(dir) && fs.readdirSync(dir).find(name => name.startsWith('pending-'));
    return file ? JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) : [];
  }
  async function prepareAgain(id = 'prepared-2') {
    harness.entry = { ...harness.entry!, owner: harness.owner, pinned: false,
      summary: { ...harness.entry!.summary, preparedId: id },
      idempotencyKey: '00000000-0000-4000-8000-000000000003' };
    return host.prepareContribution('hello', 'manual');
  }
  async function finished(id = 'prepared-1') {
    await vi.waitFor(() => expect(host.contributionTransferStatus(id).stage).toBe('complete'));
    return host.contributionTransferStatus(id);
  }
  it('releases a failed pre-commit snapshot without creating persistent upload history', async () => {
    harness.prepare.mockRejectedValueOnce(new Error('prepare response lost'));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    expect((await finished()).errorCode).toBe('INTERNAL');
    expect(pendingRows()).toEqual([]);
    expect(harness.put).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
    expect(releasePreparedContribution).toHaveBeenCalledWith('prepared-1');
  });
  // 上传器已区分“可能写入”和“尚未写入”；原成功用例没有覆盖这个错误协议。
  // 最小输入：一次 PUT 抛出带 disposition 的错误；unit，结果仍沿同一个 operation。
  it.each(['commit_same_upload', 'retry_same_url'] as const)('handles PUT disposition %s without another upload', async disposition => {
    harness.put.mockRejectedValueOnce(Object.assign(new Error('upload response lost'), { disposition }));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    const result = await finished();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
    if (disposition === 'commit_same_upload') {
      expect(result.operation?.status).toBe('succeeded');
      expect(result.errorCode).toBeNull();
      expect(harness.commit).toHaveBeenCalledTimes(1);
    } else {
      expect(result.errorCode).toBe('INTERNAL');
      expect(harness.commit).not.toHaveBeenCalled();
    }
    expect(pendingRows()).toEqual([]);
  });
  it('resolves a lost commit through the normal submit action without re-uploading or saving terminal history', async () => {
    harness.commit.mockRejectedValueOnce(new Error('commit response lost'));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await finished();
    expect(pendingRows()).toEqual([expect.objectContaining({ operationId: 'operation-1', contentSha256: sha })]);
    expect(JSON.stringify(pendingRows())).not.toContain('plugin.cindy');
    expect(JSON.stringify(pendingRows())).not.toContain('receipt');
    await prepareAgain();
    await host.submitContribution('prepared-2');
    const result = await finished('prepared-2');
    expect(result.operation?.receipt?.uploadedPackage.sha256).toBe(sha);
    expect(result.operation?.receipt?.releaseRevision.sha256).toBe(revision.sha256);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(pendingRows()).toEqual([]);
  });
  it.each(['validating', 'publishing'] as const)('confirms the same %s commit without a separate resume capability', async status => {
    harness.commit.mockRejectedValueOnce(new Error('commit response lost'));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await finished();
    const calls: string[] = [];
    harness.operation.mockImplementationOnce(async () => { calls.push('get'); return operation(status); });
    harness.commit.mockImplementationOnce(async () => { calls.push('commit'); });
    await prepareAgain();
    await host.submitContribution('prepared-2');
    expect((await finished('prepared-2')).operation?.status).toBe('succeeded');
    expect(calls).toEqual(['get', 'commit']);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(2);
  });
  it.each(['revoked', 'official'] as const)('refuses another write when the pending target becomes %s', async condition => {
    harness.preflight.mockResolvedValue({ ...(await harness.preflight()), target: {
      pluginId: 'canonical-plugin', ghostId: 'hello', version: '1.0.0', expectedRelease: null } });
    harness.commit.mockRejectedValueOnce(new Error('commit response lost'));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await finished();
    await prepareAgain();
    harness.operation.mockResolvedValueOnce(operation('publishing'));
    harness.detail.mockResolvedValue({ ...ownDetail(), plugin: { ...ownPlugin(),
      publisherKind: condition === 'official' ? 'official' : 'personal',
      actions: { canSubmit: condition !== 'revoked', canViewMarket: true } } });
    await host.submitContribution('prepared-2');
    expect((await finished('prepared-2')).errorCode).toBe(condition === 'official' ? 'OFFICIAL_PLUGIN_GITHUB_REQUIRED' : 'PERMISSION_DENIED');
    expect(harness.operation).toHaveBeenCalledWith('operation-1');
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
  });
  it('does not start another version while an earlier commit remains unconfirmed', async () => {
    harness.commit.mockRejectedValueOnce(new Error('commit response lost'));
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await finished();
    await prepareAgain();
    harness.entry!.contentSha256 = 'c'.repeat(64);
    harness.operation.mockResolvedValueOnce(operation('publishing'));
    await host.submitContribution('prepared-2');
    expect((await finished('prepared-2')).errorCode).toBe('INTERNAL');
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(pendingRows()).toHaveLength(1);
  });
  it('keeps duplicate clicks on the same active submission instead of starting another upload', async () => {
    const gate = deferred<ReturnType<typeof uploadResponse>>();
    harness.prepare.mockReturnValueOnce(gate.promise);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await prepareAgain();
    const duplicate = await host.submitContribution('prepared-2');
    expect(duplicate.localId).toBe('prepared-1');
    gate.resolve(uploadResponse());
    await finished();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });
  it('aborts a changed installation from the byte callback without throwing or committing', async () => {
    let callbackReturned = false;
    let uploadAborted = false;
    harness.put.mockImplementation(async (_handle, options) => {
      harness.readInstallation.mockImplementation(() => { throw createIpcError('PRECONDITION_FAILED', 'installation changed'); });
      options.onBytes(1);
      callbackReturned = true;
      uploadAborted = options.signal.aborted;
      throw createIpcError('MUTATION_CANCELLED', 'upload aborted');
    });
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    expect((await finished()).errorCode).toBe('MUTATION_CANCELLED');
    expect(callbackReturned && uploadAborted).toBe(true);
    expect(harness.commit).not.toHaveBeenCalled();
  });
  it('rechecks the accepted AI permission before commit after an asynchronous upload', async () => {
    const caller = vi.fn(async () => undefined);
    harness.put.mockImplementationOnce(async () => {
      caller.mockRejectedValue(createIpcError('PERMISSION_DENIED', 'task permissions changed'));
    });
    await host.prepareContribution('hello', 'ai');
    await host.submitContribution('prepared-1', caller);
    expect((await finished()).errorCode).toBe('PERMISSION_DENIED');
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.commit).not.toHaveBeenCalled();
  });
  it('does not let an old account generation overwrite a newly confirmed result', async () => {
    const gate = deferred<void>();
    harness.commit.mockReturnValueOnce(gate.promise);
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(harness.commit).toHaveBeenCalledTimes(1));
    harness.owner = `A:${testGeneration}:2`;
    await prepareAgain();
    await host.submitContribution('prepared-2');
    await finished('prepared-2');
    expect(pendingRows()).toEqual([]);
    gate.reject(new Error('late failure from the old owner'));
    await vi.waitFor(() => expect(releasePreparedContribution).toHaveBeenCalledWith('prepared-1'));
    expect(pendingRows()).toEqual([]);
    expect(host.contributionTransferStatus('prepared-2').operation?.status).toBe('succeeded');
  });
});

describe('submission preview ownership', () => {
  it('never starts an operation when the displayed package has changed', async () => {
    await host.prepareContribution('hello', 'manual');
    harness.verifyContent.mockRejectedValueOnce(new Error('[CONTRIBUTION_PACKAGE_CHANGED] changed'));
    await expect(host.submitContribution('prepared-1')).rejects.toThrow('CONTRIBUTION_PACKAGE_CHANGED');
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
    expect(releasePreparedContribution).toHaveBeenCalledWith('prepared-1');
  });
  // 原用例在 submit 返回后才关闭页面，漏掉校验 await 尚未结束时的快照释放竞态。
  // unit 最小输入：校验挂起时关闭页面；真实临时包必须保留到同一提交完成。
  it('keeps transfer bytes when a detail cleanup runs during submission validation', async () => {
    const gate = deferred<void>();
    harness.verifyContent.mockReturnValueOnce(gate.promise);
    const { directory, filePath } = harness.entry!;
    vi.mocked(releasePreparedContribution).mockImplementation(async () => {
      await fsp.rm(directory, { recursive: true, force: true });
    });
    await host.prepareContribution('hello', 'manual');
    const starting = host.submitContribution('prepared-1');
    await host.discardContribution('prepared-1');
    const retained = fs.existsSync(filePath);
    gate.resolve();
    await starting;
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1').stage).toBe('complete'));
    const result = host.contributionTransferStatus('prepared-1');
    expect(retained).toBe(true);
    expect(result.operation?.status).toBe('succeeded');
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });
  it('keeps a first submission without release notes eligible when the server allows it', async () => {
    delete harness.entry!.summary.releaseNotes;
    const prepared = await host.prepareContribution('hello', 'manual');
    expect(harness.preflight).toHaveBeenCalledWith({ pluginId: null, ghostId: 'hello', version: '1.0.0', hasReleaseNotes: false });
    expect(prepared.preflight?.actions.canSubmit).toBe(true);
    expect(prepared.preflight?.blockers).toEqual([]);
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it('blocks an unavailable preflight without remote mutation', async () => {
    harness.preflight.mockResolvedValueOnce({ subject, queriedAt: at, policyVersion: 2, target: { pluginId: null, ghostId: 'hello', version: '1.0.0', expectedRelease: null }, pendingRelease: { releaseId: 'pending', version: '0.9.0' }, blockers: [{ code: 'PLUGIN_PENDING_RELEASE_EXISTS', message: 'Review already pending' }], actions: { canSubmit: false } });
    await host.prepareContribution('hello', 'manual');
    await expect(host.submitContribution('prepared-1')).rejects.toThrow('PLUGIN_PENDING_RELEASE_EXISTS');
    expect(harness.prepare).not.toHaveBeenCalled();
  });
});

describe('review result reading state', () => {
  function approved() { return { ...submission(), reviewStatus: 'approved' as const, decidedAt: at }; }
  function plugin(latestSubmission: SubmissionView = approved()) {
    return { pluginId: 'plugin-1', updatedAt: at, latestSubmission };
  }
  // The real poll entry must skip full reads for equal owner/token, reread local
  // markers, and detect equal-timestamp new events. Existing review tests lack changes.
  it('skips list/detail for an unchanged token but detects a new event count at the same timestamp', async () => {
    harness.list.mockResolvedValue({ plugins: [plugin()], nextCursor: null });
    const service = await import('../reviewUpdates');
    const [first] = await service.reviewUpdates();
    service.markReviewRead('plugin-1', first.key);
    expect((await service.reviewUpdates())[0].unread).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(1); expect(harness.detail).toHaveBeenCalledTimes(1);
    harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 2 });
    harness.detail.mockResolvedValue({ history: { events: [{ eventId: 'disabled', type: 'disabled', at,
      releaseId: null, version: null, revision: null }], nextCursor: null } });
    expect(await service.reviewUpdates()).toEqual([expect.objectContaining({ status: 'disabled', unread: true })]);
    expect(harness.list).toHaveBeenCalledTimes(2); expect(harness.detail).toHaveBeenCalledTimes(2);
    harness.changes.mockRejectedValueOnce(new Error('changes offline'));
    await expect(service.reviewUpdates()).rejects.toThrow('changes offline');
    expect(harness.list).toHaveBeenCalledTimes(2);
  });
  it('retains the token read before a full refresh so an event arriving during it is fetched next time', async () => {
    harness.list.mockResolvedValue({ plugins: [plugin()], nextCursor: null });
    harness.detail.mockImplementationOnce(async () => {
      harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 2 });
      return { history: { events: [], nextCursor: null } };
    });
    const service = await import('../reviewUpdates');
    await service.reviewUpdates(); await service.reviewUpdates();
    expect(harness.list).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['disabled', undefined, 'disabled'], ['disabled', 'archived', 'archived'],
    ['revoked', undefined, 'revoked'], ['enabled', undefined, 'enabled'],
  ])('lets a newer %s/%s market event replace an approval and a later review replace that event', async (type, pluginStatus, status) => {
    harness.list.mockResolvedValue({ plugins: [plugin()], nextCursor: null });
    harness.detail.mockResolvedValue({ history: { events: [{ eventId: 'market-event', type, pluginStatus,
      at: '2026-10-16T00:00:00.000Z', releaseId: null, version: null, revision: null }], nextCursor: null } });
    const service = await import('../reviewUpdates');
    expect(await service.reviewUpdates()).toEqual([expect.objectContaining({ status, unread: true })]);
    harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 2 });
    harness.list.mockResolvedValue({ plugins: [plugin({ ...approved(), decidedAt: '2026-10-17T00:00:00.000Z' })], nextCursor: null });
    expect(await service.reviewUpdates()).toEqual([expect.objectContaining({ status: 'approved', decidedAt: '2026-10-17T00:00:00.000Z' })]);
  });
  it('does not light a result dot for a current-version change alone', async () => {
    harness.list.mockResolvedValue({ plugins: [plugin(submission())], nextCursor: null });
    harness.detail.mockResolvedValue({ history: { events: [{ eventId: 'current', type: 'current_changed', at,
      releaseId: revision.releaseId, version: '1.0.0', revision, reason: 'Switch version' }], nextCursor: null } });
    const service = await import('../reviewUpdates');
    expect(await service.reviewUpdates()).toEqual([]);
  });
  it('keeps an older proven approval discoverable beneath a newer pending version and caches its history', async () => {
    harness.list.mockResolvedValue({ plugins: [plugin({ ...submission(), reviewStatus: 'pending', decidedAt: null })], nextCursor: null });
    harness.detail.mockResolvedValue({ history: { events: [], nextCursor: 'older' } });
    harness.history.mockResolvedValue({ events: [{ type: 'approved', at, revision, version: '1.0.0' }], nextCursor: null });
    const service = await import('../reviewUpdates');
    const result = await service.reviewUpdates();
    expect(result).toEqual([expect.objectContaining({ pluginId: 'plugin-1', status: 'approved', unread: true, decidedAt: at })]);
    expect(harness.history).toHaveBeenCalledWith('plugin-1', 'older');
    await service.reviewUpdates();
    expect(harness.detail).toHaveBeenCalledTimes(1);
  });
  it('persists the exact decision per account across a new login generation and never acknowledges a later decision', async () => {
    harness.list.mockResolvedValue({ plugins: [plugin()], nextCursor: null });
    let service = await import('../reviewUpdates');
    const [first] = await service.reviewUpdates();
    service.markReviewRead('plugin-1', first.key);
    expect((await service.reviewUpdates())[0].unread).toBe(false);
    // reset-modules: Simulate process restart to prove markers survive an empty in-memory review cache.
    vi.resetModules();
    harness.owner = `A:${testGeneration}:2`;
    service = await import('../reviewUpdates');
    expect((await service.reviewUpdates())[0].unread).toBe(false);
    harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 2 });
    harness.list.mockResolvedValue({ plugins: [plugin({ ...approved(), decidedAt: '2026-10-16T00:00:00.000Z' })], nextCursor: null });
    expect((await service.reviewUpdates())[0].unread).toBe(true);
    expect(() => service.markReviewRead('plugin-1', first.key)).toThrow('PRECONDITION_FAILED');
    harness.owner = `B:${testGeneration}:1`;
    expect((await service.reviewUpdates())[0].unread).toBe(true);
    harness.passive = true;
    expect(() => service.markReviewRead('plugin-1', first.key)).toThrow('PRECONDITION_FAILED');
  });
  it('reads every plugin page, ignores unproven legacy decisions, and rejects late responses from a previous account', async () => {
    harness.list.mockResolvedValueOnce({ plugins: [], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ plugins: [plugin({ ...approved(), decidedAt: null })], nextCursor: null });
    harness.detail.mockResolvedValue({ history: { events: [{ type: 'approved', at, revision: null, version: '1.0.0' }], nextCursor: null } });
    const service = await import('../reviewUpdates');
    expect(await service.reviewUpdates()).toEqual([]);
    expect(harness.list).toHaveBeenLastCalledWith({ query: '', filter: 'all', cursor: 'page-2' });
    let finish!: (value: unknown) => void;
    harness.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.changes.mockResolvedValue({ subject, queriedAt: at, changedAt: at, eventCount: 2 });
    const late = service.reviewUpdates();
    await Promise.resolve();
    harness.owner = `B:${testGeneration}:1`;
    finish({ plugins: [plugin()], nextCursor: null });
    await expect(late).rejects.toThrow('OWNER_CHANGED');
    harness.list.mockRejectedValueOnce(new Error('offline'));
    await expect(service.reviewUpdates()).rejects.toThrow('offline');
  });
  // reviewUpdates 的真实分页入口；已有用例只覆盖向前翻页，漏掉重复游标占住 inFlight。
  // unit 最小输入：连续两页返回同一游标；失败后下一次正常读取仍须能得到未读审核结果。
  it.each(['list', 'history'] as const)('rejects a repeated %s cursor and permits the next review refresh', async source => {
    if (source === 'list') {
      harness.list.mockResolvedValueOnce({ plugins: [], nextCursor: 'repeat' })
        .mockResolvedValueOnce({ plugins: [], nextCursor: 'repeat' })
        .mockRejectedValue(new Error('unexpected repeated list request'));
    } else {
      harness.list.mockResolvedValue({ plugins: [plugin({ ...submission(), reviewStatus: 'pending', decidedAt: null })], nextCursor: null });
      harness.detail.mockResolvedValue({ history: { events: [], nextCursor: 'repeat' } });
      harness.history.mockResolvedValueOnce({ events: [], nextCursor: 'repeat' })
        .mockRejectedValue(new Error('unexpected repeated history request'));
    }
    const service = await import('../reviewUpdates');
    await expect(service.reviewUpdates()).rejects.toThrow('PRECONDITION_FAILED');
    expect(source === 'list' ? harness.list : harness.history).toHaveBeenCalledTimes(source === 'list' ? 2 : 1);
    harness.list.mockResolvedValue({ plugins: [plugin()], nextCursor: null });
    harness.detail.mockResolvedValue({ history: { events: [], nextCursor: null } });
    expect(await service.reviewUpdates()).toEqual([expect.objectContaining({ pluginId: 'plugin-1', unread: true })]);
  });
});


// 测试价值：列表/详情直接读取现有身份与来源，不增加发布关联或安装写入。
// 依据：namespace + id 是已安装插件身份；提审/上架不能改变安装来源。
// 缺口：原用例依赖已撤除的关联记录，无法覆盖无回执和正常本地迭代。
// 最小输入：本人 API 的一个目标和一个同 ID 安装；tier: unit。
describe('author installation projection', () => {
  // Author detail/list projection must preserve the server-owned market reason;
  // the previous hardcoded null erased every moderation explanation (unit).
  it('preserves a server market reason and keeps old responses without it readable', async () => {
    harness.list.mockResolvedValue({ plugins: [{ ...ownPlugin(), market: { ...ownPlugin().market, reason: '停止维护' } }], nextCursor: null, queriedAt: at });
    expect((await host.listMyPlugins({ query: '', filter: 'all' })).plugins[0].market.reason).toBe('停止维护');
    harness.list.mockResolvedValue({ plugins: [ownPlugin()], nextCursor: null, queriedAt: at });
    expect((await host.listMyPlugins({ query: '', filter: 'all' })).plugins[0].market.reason).toBeNull();
  });
  async function localView() {
    harness.list.mockResolvedValue({ plugins: [ownPlugin()], nextCursor: null, queriedAt: at });
    return (await host.listMyPlugins({ query: '', filter: 'all' })).plugins[0];
  }
  it('keeps official plugin facts readable while projecting client submission as unavailable', async () => {
    harness.list.mockResolvedValue({ plugins: [{ ...ownPlugin(), publisherKind: 'official' }], nextCursor: null, queriedAt: at });
    const result = (await host.listMyPlugins({ query: '', filter: 'all' })).plugins[0];
    expect(result).toMatchObject({ publisherKind: 'official', actions: { submitUpdate: false },
      localInstallation: { state: 'installed', version: '1.0.0', origin: 'local' } });
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.snapshot).not.toHaveBeenCalled();
  });
  it('shows the installed local version without a submission or a separate association', async () => {
    expect(await localView()).toMatchObject({ localInstallation: {
      state: 'installed', instanceId: 'hello', origin: 'local', version: '1.0.0', enabled: true,
    }, localInstanceId: 'hello' });
    expect((await host.myPluginDetail('canonical-plugin')).plugin.localVersion).toBe('1.0.0');
    harness.ghosts[0] = { ...harness.ghosts[0], enabled: false,
      manifest: { ...harness.ghosts[0].manifest, name: 'Renamed plugin', version: '1.2.0' },
      approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000099' } };
    expect(await localView()).toMatchObject({ localInstallation: {
      state: 'installed', version: '1.2.0', enabled: false, origin: 'local',
    } });
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
  });
  it('does not match another ID or organization namespace, even with the same display name', async () => {
    const original = harness.ghosts[0];
    harness.ghosts = [{ ...original, manifest: { ...original.manifest, id: 'different' } }];
    expect((await localView()).localInstallation).toEqual({ state: 'missing' });
    harness.ghosts = [{ ...original, namespace: 'org' }];
    expect((await localView()).localInstallation).toEqual({ state: 'missing' });
  });
  it('reports unavailable instead of missing when the installation cannot be read', async () => {
    harness.ghosts = [];
    harness.readAvailable.mockImplementation(() => { throw new Error('unreadable registry'); });
    expect(await localView()).toMatchObject({ localInstallation: { state: 'unavailable' }, localInstanceId: null });
    expect(harness.readAvailable).toHaveBeenCalledWith('hello');
  });
  it('does not change the local source after a submission succeeds', async () => {
    await host.prepareContribution('hello', 'manual');
    await host.submitContribution('prepared-1');
    await vi.waitFor(() => expect(host.contributionTransferStatus('prepared-1').stage).toBe('complete'));
    expect(host.contributionTransferStatus('prepared-1').operation?.status).toBe('succeeded');
    expect((await localView()).localInstallation).toMatchObject({ state: 'installed', origin: 'local' });
    expect(harness.ghosts).toHaveLength(1);
  });
  it('never substitutes a private, custom, or unverified installation for this public target', async () => {
    harness.ghosts[0].publishingSource = { kind: 'unavailable' };
    expect(await localView()).toMatchObject({ localInstallation: { state: 'unavailable' }, localInstanceId: null });
  });
  it('matches public installations using their existing source ledger and approved package', async () => {
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'canonical-plugin' };
    const ledger = new PluginMarketLedger(path.join(harness.root, 'plugin-market', 'ledger.v1.json'));
    const record = { pluginId: 'canonical-plugin', ghostId: 'hello', namespace: null,
      releaseId: 'release-1', version: '1.0.0', sha256: sha, scope: 'public' as const, organizationId: null,
      source: 'market' as const, installed: true, updatedAt: at };
    ledger.upsertInstallation(record);
    harness.evidence.mockReturnValue({ packageSha256: sha });
    expect(await localView()).toMatchObject({ localInstallation: {
      state: 'installed', instanceId: 'hello', version: '1.0.0', origin: 'public',
    } });
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'different-plugin' };
    expect((await localView()).localInstallation).toEqual({ state: 'unavailable' });
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'canonical-plugin' };
    ledger.upsertInstallation({ ...record, pluginId: 'different-plugin' });
    expect((await localView()).localInstanceId).toBeNull();
    expect(harness.snapshot).not.toHaveBeenCalled();
  });
  it('resolves a local update through server preflight and checks the returned publishing permission', async () => {
    harness.preflight.mockResolvedValue({ ...(await harness.preflight()), target: {
      pluginId: 'canonical-plugin', ghostId: 'hello', version: '1.0.0', expectedRelease: null } });
    await host.prepareContribution('hello', 'manual');
    expect(harness.preflight).toHaveBeenCalledWith({ pluginId: null, ghostId: 'hello', version: '1.0.0', hasReleaseNotes: true });
    expect(harness.detail).toHaveBeenCalledWith('canonical-plugin');
    harness.detail.mockResolvedValue({ ...ownDetail(), plugin: {
      ...ownPlugin(), actions: { canSubmit: false, canViewMarket: false },
    } });
    await expect(host.prepareContribution('hello', 'manual')).rejects.toThrow('PERMISSION_DENIED');
  });
});
