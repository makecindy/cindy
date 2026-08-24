import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginPublisherApi } from '../api.js';
import { PluginPublisherPutError } from '../putObject.js';
import { createPluginPublisherOrchestrator } from '../orchestrator.js';
import { PluginPublisherApiError } from '../api.js';
import {
  PLUGIN_PUBLISHER_COMMIT_MARGIN_MS,
  remainingPutBudgetMs,
  type PluginPublisherProgress,
} from '../types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function packagePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-publisher-orch-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'demo.cindy');
  await fs.writeFile(filePath, Buffer.from('not-a-real-zip-but-sized'));
  return filePath;
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function waitFor(
  snapshots: PluginPublisherProgress[],
  predicate: (progress: PluginPublisherProgress) => boolean,
): Promise<PluginPublisherProgress> {
  const existing = snapshots.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = snapshots.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      }
    }, 10);
  });
}

const prepared = {
  uploadId: 'upload-1',
  putUrl: 'https://bucket.example.test/object',
  headers: {
    'Content-Type': 'application/octet-stream',
    'x-oss-forbid-overwrite': 'true',
  },
  expiresAt: '2099-08-19T08:15:00.000Z',
  status: 'awaiting_upload' as const,
};

describe('PluginPublisherOrchestrator', () => {
  it('caps pending confirmations per owner before opening another package', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const confirmations: Array<ReturnType<typeof deferredBoolean>> = [];
    const openFile = vi.fn(async (candidate: string, flags: string | number) =>
      fs.open(candidate, flags),
    );
    const orch = createPluginPublisherOrchestrator({
      api: { prepare: vi.fn(), commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: () => {
        const confirmation = deferredBoolean();
        confirmations.push(confirmation);
        return confirmation.promise;
      },
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      openFile: openFile as typeof fs.open,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });

    orch.start(filePath);
    orch.start(filePath);
    await vi.waitFor(() => expect(confirmations).toHaveLength(2));
    const rejected = orch.start(filePath);
    const failed = await waitFor(
      snapshots,
      (progress) => progress.transferId === rejected.transferId && progress.stage === 'failed',
    );

    // Excludes both an unbounded confirmation map and a quota placed after open().
    expect(failed.errorCode).toBe('SERVER_BUSY');
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(confirmations).toHaveLength(2);

    orch.abortAll();
  });

  it('keeps the pending-confirmation quota isolated by active-session owner', async () => {
    const filePath = await packagePath();
    const confirmations: Array<ReturnType<typeof deferredBoolean>> = [];
    let owner = { mode: 'cloud' as const, dataOwnerId: 'member-a', generation: 1 };
    const orch = createPluginPublisherOrchestrator({
      api: { prepare: vi.fn(), commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: () => {
        const confirmation = deferredBoolean();
        confirmations.push(confirmation);
        return confirmation.promise;
      },
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      owner: () => owner,
    });

    orch.start(filePath);
    orch.start(filePath);
    await vi.waitFor(() => expect(confirmations).toHaveLength(2));
    owner = { ...owner, dataOwnerId: 'member-b' };
    const otherOwner = orch.start(filePath);

    // Excludes a global cap that lets one owner exhaust another owner's allowance.
    await vi.waitFor(() => expect(confirmations).toHaveLength(3));
    expect(orch.snapshot(otherOwner.transferId)?.stage).toBe('confirming');
    orch.abortAll();
  });

  it.each(['accepted', 'rejected', 'aborted', 'failed'] as const)(
    'releases pending-confirmation capacity after a confirmation is %s',
    async (outcome) => {
      const filePath = await packagePath();
      const confirmations: Array<ReturnType<typeof deferredBoolean>> = [];
      const orch = createPluginPublisherOrchestrator({
        api: {
          prepare: vi.fn(async () => {
            throw new Error('stop after confirmation');
          }),
          commit: vi.fn(),
          status: vi.fn(),
        } as unknown as PluginPublisherApi,
        inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
        confirm: () => {
          const confirmation = deferredBoolean();
          confirmations.push(confirmation);
          return confirmation.promise;
        },
        identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      });

      const first = orch.start(filePath);
      orch.start(filePath);
      await vi.waitFor(() => expect(confirmations).toHaveLength(2));
      if (outcome === 'accepted') confirmations[0].resolve(true);
      else if (outcome === 'rejected') confirmations[0].resolve(false);
      else if (outcome === 'aborted') {
        expect(orch.cancel(first.transferId)).toEqual({ cancelled: true });
      } else confirmations[0].reject(new Error('confirmation failed'));
      await vi.waitFor(() =>
        expect(orch.snapshot(first.transferId)?.stage).toMatch(/^(failed|cancelled)$/),
      );

      const next = orch.start(filePath);
      // Excludes a leaked counter on the accept, reject, and abort exits respectively.
      await vi.waitFor(() => expect(confirmations).toHaveLength(3));
      expect(orch.snapshot(next.transferId)?.stage).toBe('confirming');

      confirmations[1].resolve(false);
      confirmations[2].resolve(false);
      await vi.waitFor(() => expect(orch.snapshot(next.transferId)?.stage).toBe('failed'));
    },
  );

  it('hides status and cancel from a different active-session owner', async () => {
    const filePath = await packagePath();
    const owner = { mode: 'cloud' as const, dataOwnerId: 'member-1', generation: 7 };
    let resolveConfirm!: (confirmed: boolean) => void;
    const confirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const orch = createPluginPublisherOrchestrator({
      api: { prepare: vi.fn(), commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: () => confirm,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      owner: () => owner,
    });
    const started = orch.start(filePath);
    const differentOwner = { ...owner, generation: owner.generation + 1 };

    // Excludes leaking whether a transferId exists after an owner switch.
    expect(orch.snapshotForOwner(started.transferId, differentOwner)).toBeNull();
    expect(orch.cancelForOwner(started.transferId, differentOwner)).toEqual({
      cancelled: false,
    });
    expect(orch.snapshotForOwner(started.transferId, owner)?.stage).toBe('confirming');
    expect(orch.cancelForOwner(started.transferId, owner)).toEqual({ cancelled: true });

    resolveConfirm(false);
    await vi.waitFor(() =>
      expect(orch.snapshotForOwner(started.transferId, owner)?.stage).toBe('cancelled'),
    );
  });

  it('returns immediately while confirmation and transfer continue in the background', async () => {
    const filePath = await packagePath();
    let resolveConfirm!: (confirmed: boolean) => void;
    const confirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const orch = createPluginPublisherOrchestrator({
      api: { prepare: vi.fn(), commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: () => confirm,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
    });
    const started = orch.start(filePath);
    expect(started.uploadId).toBeNull();
    expect(orch.snapshot(started.transferId)?.stage).toBe('confirming');
    resolveConfirm(false);
    await vi.waitFor(() => expect(orch.snapshot(started.transferId)?.stage).toBe('failed'));
  });

  it('keeps polling after commit until a terminal status', async () => {
    const filePath = await packagePath();
    const statuses = ['validating', 'publishing', 'succeeded'] as const;
    let statusCalls = 0;
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: vi.fn(async () => prepared),
        commit: vi.fn(async () => ({ uploadId: 'upload-1', status: 'validating' })),
        status: vi.fn(async () => {
          const status = statuses[Math.min(statusCalls, statuses.length - 1)];
          statusCalls += 1;
          return {
            uploadId: 'upload-1',
            status,
            pluginId: status === 'succeeded' ? `c${'a'.repeat(24)}` : null,
            releaseId: status === 'succeeded' ? 'rel-1' : null,
            ghostId: status === 'succeeded' ? 'demo' : null,
            version: status === 'succeeded' ? '1.0.0' : null,
            reviewStatus: status === 'succeeded' ? 'pending' : null,
            failure: null,
          };
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });

    orch.start(filePath);
    const done = await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(done.uploadId).toBe('upload-1');
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it('reads commit body.status expired instead of treating HTTP 202 as success', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const status = vi.fn();
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'expired' }),
        status,
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const expired = await waitFor(snapshots, (progress) => progress.stage === 'expired');
    expect(expired.status).toBe('expired');
    expect(status).not.toHaveBeenCalled();
  });

  it('retries the same putUrl when the request never reached storage, otherwise commits', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let puts = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => ({
          uploadId: 'upload-1',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts += 1;
        if (puts === 1) {
          throw new PluginPublisherPutError('dns', 'retry_same_url');
        }
        return { bytesSent: 24 };
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(puts).toBe(2);

    const snapshots2: PluginPublisherProgress[] = [];
    let puts2 = 0;
    const commit = vi.fn(async () => ({ uploadId: 'upload-2', status: 'validating' as const }));
    const orch2 = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => ({ ...prepared, uploadId: 'upload-2' }),
        commit,
        status: async () => ({
          uploadId: 'upload-2',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts2 += 1;
        throw new PluginPublisherPutError('timeout', 'commit_same_upload', 0);
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots2.push({ ...progress }),
    });
    orch2.start(filePath);
    await waitFor(snapshots2, (progress) => progress.stage === 'succeeded');
    expect(puts2).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);

    const snapshots3: PluginPublisherProgress[] = [];
    let puts3 = 0;
    const commit3 = vi.fn(async () => ({ uploadId: 'upload-3', status: 'validating' as const }));
    const orch3 = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => ({ ...prepared, uploadId: 'upload-3' }),
        commit: commit3,
        status: async () => ({
          uploadId: 'upload-3',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts3 += 1;
        if (puts3 === 1) throw new PluginPublisherPutError('dns', 'retry_same_url');
        throw new PluginPublisherPutError('5xx', 'commit_same_upload', 500);
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots3.push({ ...progress }),
    });
    orch3.start(filePath);
    await waitFor(snapshots3, (progress) => progress.stage === 'succeeded');
    expect(puts3).toBe(2);
    expect(commit3).toHaveBeenCalledTimes(1);
  });

  it('recomputes the remaining absolute PUT budget before a retry', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let now = Date.parse('2026-08-19T07:15:00.000Z');
    const expiresAt = new Date(now + PLUGIN_PUBLISHER_COMMIT_MARGIN_MS + 5_000).toISOString();
    const budgets: number[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => ({ ...prepared, expiresAt }),
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => ({
          uploadId: 'upload-1',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      now: () => now,
      putFile: async (_handle, options) => {
        if (options.maxTotalMs === undefined) throw new Error('missing PUT budget');
        budgets.push(options.maxTotalMs);
        if (budgets.length === 1) {
          now += 3_000;
          throw new PluginPublisherPutError('timeout', 'retry_same_url');
        }
        return { bytesSent: 24 };
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });

    orch.start(filePath);
    await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    // Excludes restarting the original five-second relative timeout on retry.
    expect(budgets).toEqual([5_000, 2_000]);
  });

  it('derives the PUT deadline from expiresAt minus a commit margin', () => {
    const now = Date.parse('2099-08-19T07:15:00.000Z');
    const budget = remainingPutBudgetMs(prepared.expiresAt, now);
    const sessionLeft = Date.parse(prepared.expiresAt) - now;
    expect(budget).toBe(sessionLeft - PLUGIN_PUBLISHER_COMMIT_MARGIN_MS);
    expect(budget).toBeLessThan(sessionLeft);
  });

  it('retries transient 503 status polls instead of failing the transfer', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let statusCalls = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            throw new PluginPublisherApiError('AUTH_CONTEXT_UNAVAILABLE', 503, 'busy');
          }
          return {
            uploadId: 'upload-1',
            status: 'succeeded',
            pluginId: `c${'a'.repeat(24)}`,
            releaseId: 'rel-1',
            ghostId: 'demo',
            version: '1.0.0',
            reviewStatus: 'pending',
            failure: null,
          };
        },
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const done = await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(done.reviewStatus).toBe('pending');
    expect(statusCalls).toBe(2);
    expect(snapshots.some((progress) => progress.message === '服务端繁忙，重试中')).toBe(true);
  });

  it('maps two retry_same_url failures to a network error instead of INTERNAL', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: vi.fn(),
        status: vi.fn(),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        throw new PluginPublisherPutError('dns', 'retry_same_url');
      },
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const failed = await waitFor(snapshots, (progress) => progress.stage === 'failed');
    expect(failed.errorCode).toBe('NETWORK_UNREACHABLE');
  });

  it('refreshes reviewStatus after succeeded when asked', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let statusCalls = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => {
          statusCalls += 1;
          return {
            uploadId: 'upload-1',
            status: 'succeeded',
            pluginId: `c${'a'.repeat(24)}`,
            releaseId: 'rel-1',
            ghostId: 'demo',
            version: '1.0.0',
            reviewStatus: statusCalls === 1 ? 'pending' : 'approved',
            failure: null,
          };
        },
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    const started = orch.start(filePath);
    await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    const refreshed = await orch.refreshReviewStatus(started.transferId);
    expect(refreshed?.reviewStatus).toBe('approved');
    expect(statusCalls).toBe(2);
  });

  it('rejects an inspected manifest id that differs from the consumed pack ticket', async () => {
    const filePath = await packagePath();
    const prepare = vi.fn();
    const confirm = vi.fn(async () => true);
    const cleanup = vi.fn();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: { prepare, commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'other-id', name: 'Other', version: '1.0.0' }),
      confirm,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath, {
      sourceBinding: {
        manifestId: 'demo',
        packageSha256: await fileSha256(filePath),
        onTerminal: cleanup,
      },
    });
    const failed = await waitFor(snapshots, (progress) => progress.stage === 'failed');
    expect(failed.errorCode).toBe('PUBLISH_PACKAGE_ID_MISMATCH');
    expect(confirm).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it('rejects rewritten staging bytes before prepare or PUT', async () => {
    const filePath = await packagePath();
    const expectedSha256 = await fileSha256(filePath);
    await fs.writeFile(filePath, Buffer.from('rewritten-staging-package'));
    expect(await fileSha256(filePath)).not.toBe(expectedSha256);
    const prepare = vi.fn();
    const putFile = vi.fn();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: { prepare, commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath, {
      sourceBinding: { manifestId: 'demo', packageSha256: expectedSha256 },
    });
    const failed = await waitFor(snapshots, (progress) => progress.stage === 'failed');
    expect(failed.errorCode).toBe('PUBLISH_PACKAGE_SHA256_MISMATCH');
    expect(prepare).not.toHaveBeenCalled();
    expect(putFile).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'success', confirm: true, inspectFails: false, terminal: 'succeeded' },
    { label: 'failure', confirm: true, inspectFails: true, terminal: 'failed' },
  ])(
    'releases forge staging at the $label terminal outcome',
    async ({ confirm, inspectFails, terminal }) => {
      const filePath = await packagePath();
      const cleanup = vi.fn();
      const snapshots: PluginPublisherProgress[] = [];
      const orch = createPluginPublisherOrchestrator({
        api: {
          prepare: async () => prepared,
          commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
          status: async () => ({
            uploadId: 'upload-1',
            status: 'succeeded',
            pluginId: `c${'a'.repeat(24)}`,
            releaseId: 'rel-1',
            ghostId: 'demo',
            version: '1.0.0',
            reviewStatus: 'pending',
            failure: null,
          }),
        } as unknown as PluginPublisherApi,
        inspectPackage: async () => {
          if (inspectFails) throw new Error('inspect failed');
          return { ghostId: 'demo', name: 'Demo', version: '1.0.0' };
        },
        confirm: async () => confirm,
        identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
        putFile: async () => ({ bytesSent: 24 }),
        sleep: async () => undefined,
        onProgress: (progress) => snapshots.push({ ...progress }),
      });
      orch.start(filePath, {
        sourceBinding: {
          manifestId: 'demo',
          packageSha256: await fileSha256(filePath),
          onTerminal: cleanup,
        },
      });
      await waitFor(snapshots, (progress) => progress.stage === terminal);
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    },
  );

  it('releases forge staging when the background transfer is cancelled', async () => {
    const filePath = await packagePath();
    const cleanup = vi.fn();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: { prepare: vi.fn(), commit: vi.fn(), status: vi.fn() } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    const started = orch.start(filePath, {
      sourceBinding: {
        manifestId: 'demo',
        packageSha256: await fileSha256(filePath),
        onTerminal: cleanup,
      },
    });
    expect(orch.cancel(started.transferId)).toEqual({ cancelled: true });
    await waitFor(snapshots, (progress) => progress.stage === 'cancelled');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it.each([
    { status: 404, code: 'INTERNAL_ERROR', expected: 'PUBLISH_UNSUPPORTED' },
    { status: 405, code: 'INTERNAL_ERROR', expected: 'PUBLISH_UNSUPPORTED' },
    { status: 503, code: 'INTERNAL_ERROR', expected: 'PUBLISH_UNSUPPORTED' },
    { status: 503, code: 'RATE_LIMIT_UNAVAILABLE', expected: 'RATE_LIMIT_UNAVAILABLE' },
    { status: 503, code: 'STORAGE_UNAVAILABLE', expected: 'STORAGE_UNAVAILABLE' },
  ])('maps prepare $status/$code to $expected', async ({ status, code, expected }) => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => {
          throw new PluginPublisherApiError(code, status, 'redacted');
        },
        commit: vi.fn(),
        status: vi.fn(),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const failed = await waitFor(snapshots, (progress) => progress.stage === 'failed');
    expect(failed.errorCode).toBe(expected);
  });
});
