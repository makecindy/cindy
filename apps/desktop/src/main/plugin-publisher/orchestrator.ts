/**
 * Member-upload transfer table + orchestration.
 *
 * Keys are Host-minted transferIds, never MCP callIds. Pipeline:
 * hash → prepare → PUT → commit → keep polling until a terminal upload
 * status. Polling is a driver: GET during validating/publishing reschedules
 * the server worker with a fresh Connection JWT.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import {
  PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
  type PluginMemberUploadStatusResponse,
} from '@cindy/plugin-protocol';

import {
  getActiveAppSession,
  type ActiveAppSession,
} from '../appSessionState.js';
import { sameActiveAppSessionOwner } from '../cindy-brain/forgePackPublishConsume.js';
import { PluginPublisherApi, PluginPublisherApiError } from './api.js';
import { hashLocalFile, PluginPublisherHashCancelledError } from './hashFile.js';
import { PluginPublisherPutError, putLocalFile } from './putObject.js';
import {
  PLUGIN_PUBLISHER_MAX_CONCURRENT,
  PLUGIN_PUBLISHER_MIN_PUT_BUDGET_MS,
  PLUGIN_PUBLISHER_POLL_INTERVAL_MS,
  PLUGIN_PUBLISHER_POLL_MAX_TRANSIENT_RETRIES,
  PLUGIN_PUBLISHER_POLL_TRANSIENT_BACKOFF_MS,
  putDeadlineAtMs,
  type PluginPublisherProgress,
  type PluginPublisherStage,
  type PluginPublisherStartResult,
} from './types.js';

const TERMINAL_UPLOAD_STATUSES = new Set(['succeeded', 'failed', 'expired']);

export interface PluginPublisherOrchestratorDeps {
  api: PluginPublisherApi;
  inspectPackage(filePath: string): Promise<{
    ghostId: string;
    name: string;
    version: string;
  }>;
  confirm(
    facts: {
      orgSlug: string;
      orgName: string | null;
      ghostId: string;
      name: string;
      version: string;
      sizeBytes: number;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
  identity(): { membershipId: string; orgSlug: string; orgName: string | null } | null;
  owner?: () => ActiveAppSession;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (progress: PluginPublisherProgress) => void;
  putFile?: typeof putLocalFile;
  openFile?: typeof fsPromises.open;
  inspectGate?: { acquire(signal: AbortSignal): Promise<void>; release(): void };
}

export interface PluginPublisherSourceBinding {
  manifestId: string;
  packageSha256: string;
  /** Agent forge staging is released once this background transfer terminates. */
  onTerminal?: () => void | Promise<void>;
}

interface TransferRecord {
  transferId: string;
  uploadId: string | null;
  filePath: string;
  owner: ActiveAppSession;
  controller: AbortController;
  progress: PluginPublisherProgress;
  run: Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isPathSafeForPublish(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  if (filePath.includes('\0')) return false;
  return path.extname(filePath).toLowerCase() === '.cindy';
}

class PluginPublisherPutDeadlineExpiredError extends Error {}

async function waitForConfirmationOrAbort(
  confirmation: Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    confirmation.then(
      (confirmed) => {
        cleanup();
        resolve(confirmed);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

class SerialGate {
  private active = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(signal: AbortSignal): Promise<void> {
    if (!this.active) {
      this.active = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active = true;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = false;
  }
}

export class PluginPublisherOrchestrator {
  private readonly transfers = new Map<string, TransferRecord>();
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly inspectGate: { acquire(signal: AbortSignal): Promise<void>; release(): void };
  private readonly owner: () => ActiveAppSession;
  private readonly openFile: typeof fsPromises.open;
  private readonly pendingConfirmations: Array<{ owner: ActiveAppSession; count: number }> = [];

  constructor(private readonly deps: PluginPublisherOrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.inspectGate = deps.inspectGate ?? new SerialGate();
    this.owner = deps.owner ?? getActiveAppSession;
    this.openFile = deps.openFile ?? fsPromises.open;
  }

  start(
    filePath: string,
    extras?: {
      confirm?: PluginPublisherOrchestratorDeps['confirm'];
      sourceBinding?: PluginPublisherSourceBinding;
    },
  ): PluginPublisherStartResult {
    const transferId = randomUUID();
    const controller = new AbortController();
    const progress: PluginPublisherProgress = {
      transferId,
      uploadId: null,
      stage: 'confirming',
    };
    const record: TransferRecord = {
      transferId,
      uploadId: null,
      filePath,
      owner: this.owner(),
      controller,
      progress,
      run: Promise.resolve(),
    };
    this.transfers.set(transferId, record);
    record.run = this.run(
      record,
      extras?.confirm ?? this.deps.confirm,
      extras?.sourceBinding,
    ).catch(() => undefined);
    this.emit(record);
    return { transferId, uploadId: null };
  }

  snapshot(transferId: string): PluginPublisherProgress | null {
    return this.transfers.get(transferId)?.progress ?? null;
  }

  snapshotForOwner(
    transferId: string,
    owner: ActiveAppSession,
  ): PluginPublisherProgress | null {
    const record = this.transfers.get(transferId);
    return record && sameActiveAppSessionOwner(record.owner, owner)
      ? record.progress
      : null;
  }

  listActive(): PluginPublisherProgress[] {
    return [...this.transfers.values()]
      .map((record) => record.progress)
      .filter((progress) => !isTerminalStage(progress.stage));
  }

  cancel(transferId: string): { cancelled: boolean } {
    const record = this.transfers.get(transferId);
    if (!record || isTerminalStage(record.progress.stage)) return { cancelled: false };
    record.controller.abort();
    return { cancelled: true };
  }

  cancelForOwner(
    transferId: string,
    owner: ActiveAppSession,
  ): { cancelled: boolean } {
    const record = this.transfers.get(transferId);
    if (!record || !sameActiveAppSessionOwner(record.owner, owner)) {
      return { cancelled: false };
    }
    return this.cancel(transferId);
  }

  abortAll(): void {
    for (const record of this.transfers.values()) {
      if (!isTerminalStage(record.progress.stage)) record.controller.abort();
    }
  }

  private emit(record: TransferRecord): void {
    this.deps.onProgress?.(record.progress);
  }

  private update(record: TransferRecord, patch: Partial<PluginPublisherProgress>): void {
    record.progress = { ...record.progress, ...patch, transferId: record.transferId };
    if (patch.uploadId) record.uploadId = patch.uploadId;
    this.emit(record);
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (this.activeCount < PLUGIN_PUBLISHER_MAX_CONCURRENT) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.activeCount += 1;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waiters.shift();
    next?.();
  }

  private tryAcquirePendingConfirmation(owner: ActiveAppSession): boolean {
    const entry = this.pendingConfirmations.find((candidate) =>
      sameActiveAppSessionOwner(candidate.owner, owner),
    );
    if (entry) {
      // Align the pending-confirmation cap with the upload concurrency cap: more
      // than two simultaneous confirmations is not a normal publishing flow.
      if (entry.count >= PLUGIN_PUBLISHER_MAX_CONCURRENT) return false;
      entry.count += 1;
      return true;
    }
    this.pendingConfirmations.push({ owner, count: 1 });
    return true;
  }

  private releasePendingConfirmation(owner: ActiveAppSession): void {
    const index = this.pendingConfirmations.findIndex((candidate) =>
      sameActiveAppSessionOwner(candidate.owner, owner),
    );
    if (index < 0) return;
    const entry = this.pendingConfirmations[index];
    if (entry.count <= 1) this.pendingConfirmations.splice(index, 1);
    else entry.count -= 1;
  }

  private async run(
    record: TransferRecord,
    confirm: PluginPublisherOrchestratorDeps['confirm'],
    sourceBinding?: PluginPublisherSourceBinding,
  ): Promise<void> {
    const signal = record.controller.signal;
    let handle: fsPromises.FileHandle | null = null;
    let pendingConfirmationHeld = false;
    try {
      if (!isPathSafeForPublish(record.filePath)) {
        this.fail(record, 'INVALID_PARAMS', '只能发布 .cindy 插件包');
        return;
      }
      const identity = this.deps.identity();
      if (!identity) {
        this.fail(record, 'NOT_ORG_MEMBER', '需要组织身份才能发布插件');
        return;
      }

      await this.inspectGate.acquire(signal);
      let inspected: { ghostId: string; name: string; version: string };
      try {
        inspected = await this.deps.inspectPackage(record.filePath);
      } finally {
        this.inspectGate.release();
      }
      if (sourceBinding && inspected.ghostId !== sourceBinding.manifestId) {
        this.fail(record, 'PUBLISH_PACKAGE_ID_MISMATCH', '打包票据与待发布插件 id 不一致');
        return;
      }
      // Inspect is serialized and short-lived. Reserve the durable open-fd / confirmation
      // resource only after inspect succeeds, but before opening the package.
      if (!this.tryAcquirePendingConfirmation(record.owner)) {
        this.fail(record, 'SERVER_BUSY', '待确认的发布任务过多，请先处理已有确认');
        return;
      }
      pendingConfirmationHeld = true;
      handle = await this.openFile(record.filePath, fs.constants.O_RDONLY);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        this.fail(record, 'INVALID_PARAMS', '只能发布普通文件');
        return;
      }
      if (stat.size <= 0 || stat.size > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES) {
        this.fail(record, 'TOO_LARGE', '插件包超过 128 MiB');
        return;
      }

      this.update(record, {
        stage: 'confirming',
        ghostId: inspected.ghostId,
        version: inspected.version,
        pluginName: inspected.name,
        orgSlug: identity.orgSlug,
        totalBytes: stat.size,
      });
      const confirmed = await waitForConfirmationOrAbort(
        confirm(
          {
            orgSlug: identity.orgSlug,
            orgName: identity.orgName,
            ghostId: inspected.ghostId,
            name: inspected.name,
            version: inspected.version,
            sizeBytes: stat.size,
          },
          signal,
        ),
        signal,
      );
      this.releasePendingConfirmation(record.owner);
      pendingConfirmationHeld = false;
      if (!confirmed || signal.aborted) {
        this.update(record, {
          stage: signal.aborted ? 'cancelled' : 'failed',
          errorCode: signal.aborted ? null : 'CONFIRM_UNAVAILABLE',
          message: signal.aborted
            ? cancelMessage(record.uploadId !== null)
            : '请在 Cindy 窗口内重试',
        });
        return;
      }

      await this.acquireSlot(signal);
      try {
        this.update(record, { stage: 'hashing', bytesHashed: 0, totalBytes: stat.size });
        const digest = await hashLocalFile(handle, {
          signal,
          onProgress: ({ bytesRead, totalBytes }) => {
            this.update(record, { stage: 'hashing', bytesHashed: bytesRead, totalBytes });
          },
        });
        if (digest.sizeBytes !== stat.size) {
          this.fail(record, 'UPLOAD_SIZE_MISMATCH', '文件在校验期间被修改，请重新选择');
          return;
        }
        if (sourceBinding && digest.sha256 !== sourceBinding.packageSha256) {
          this.fail(record, 'PUBLISH_PACKAGE_SHA256_MISMATCH', '待发布插件字节已不是本次打包产物');
          return;
        }

        this.update(record, { stage: 'preparing', totalBytes: digest.sizeBytes });
        let prepared: Awaited<ReturnType<PluginPublisherApi['prepare']>>;
        try {
          prepared = await this.deps.api.prepare({
            sizeBytes: digest.sizeBytes,
            sha256: digest.sha256,
          });
        } catch (error) {
          if (isUnsupportedPrepareEndpoint(error)) {
            this.fail(record, 'PUBLISH_UNSUPPORTED', '当前企业服务端不支持成员发布');
            return;
          }
          throw error;
        }
        this.update(record, { uploadId: prepared.uploadId, stage: 'uploading', bytesSent: 0 });

        const putFile = this.deps.putFile ?? putLocalFile;
        const openHandle = handle;
        const putDeadline = putDeadlineAtMs(prepared.expiresAt, this.now());
        const putOnce = () => {
          const remainingBudgetMs = putDeadline - this.now();
          if (remainingBudgetMs < PLUGIN_PUBLISHER_MIN_PUT_BUDGET_MS) {
            throw new PluginPublisherPutDeadlineExpiredError();
          }
          return putFile(openHandle, {
            putUrl: prepared.putUrl,
            headers: prepared.headers,
            sizeBytes: digest.sizeBytes,
            signal,
            maxTotalMs: remainingBudgetMs,
            onBytes: (bytesSent) => {
              this.update(record, { stage: 'uploading', bytesSent, totalBytes: digest.sizeBytes });
            },
          });
        };
        let putOutcome: Awaited<ReturnType<PluginPublisherOrchestrator['putWithRecovery']>>;
        try {
          putOutcome = await this.putWithRecovery(putOnce);
        } catch (error) {
          if (error instanceof PluginPublisherPutDeadlineExpiredError) {
            this.update(record, {
              stage: 'expired',
              status: 'expired',
              message: '上传会话已过期',
            });
            return;
          }
          throw error;
        }
        if (putOutcome === 'cancelled_incomplete' || putOutcome === 'cancelled_uncertain') {
          this.update(record, {
            stage: 'cancelled',
            message:
              putOutcome === 'cancelled_uncertain'
                ? '已取消，上传结果不确定'
                : '已取消发布',
          });
          return;
        }
        if (putOutcome === 'network_unreachable') {
          this.fail(record, 'NETWORK_UNREACHABLE', '网络无法连接，可以重试');
          return;
        }

        this.update(record, { stage: 'committing' });
        const committed = await this.commitWithRetry(record, prepared.uploadId, signal);
        if (committed === 'cancelled') return;
        if (committed.status === 'expired') {
          this.update(record, { stage: 'expired', status: 'expired', message: '上传会话已过期' });
          return;
        }
        await this.pollUntilTerminal(record, prepared.uploadId, signal);
      } finally {
        this.releaseSlot();
      }
    } catch (error) {
      if (signal.aborted || error instanceof PluginPublisherHashCancelledError) {
        this.update(record, {
          stage: 'cancelled',
          message: cancelMessage(record.uploadId !== null && record.progress.stage !== 'uploading'),
        });
        return;
      }
      if (error instanceof PluginPublisherApiError) {
        this.fail(record, error.code, mapPublisherApiMessage(error));
        return;
      }
      this.fail(record, 'INTERNAL', '发布失败');
    } finally {
      if (pendingConfirmationHeld) this.releasePendingConfirmation(record.owner);
      await handle?.close().catch(() => undefined);
      try {
        await sourceBinding?.onTerminal?.();
      } catch {
        // Cleanup must never rewrite the already-final transfer outcome.
      }
    }
  }

  private async pollUntilTerminal(
    record: TransferRecord,
    uploadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let transientRetries = 0;
    while (!signal.aborted) {
      try {
        const status = await this.deps.api.status(uploadId);
        transientRetries = 0;
        this.applyStatus(record, status);
        if (TERMINAL_UPLOAD_STATUSES.has(status.status)) return;
        await this.sleep(PLUGIN_PUBLISHER_POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (isTransientPublisherApiError(error)) {
          transientRetries += 1;
          if (transientRetries > PLUGIN_PUBLISHER_POLL_MAX_TRANSIENT_RETRIES) {
            this.fail(record, 'SERVER_BUSY', '服务端繁忙，请稍后重试');
            return;
          }
          this.update(record, {
            stage: 'processing',
            message: '服务端繁忙，重试中',
          });
          await this.sleep(
            PLUGIN_PUBLISHER_POLL_TRANSIENT_BACKOFF_MS * transientRetries,
            signal,
          );
          continue;
        }
        if (error instanceof PluginPublisherApiError && isTerminalPublisherClientError(error)) {
          this.fail(record, error.code, mapPublisherApiMessage(error));
          return;
        }
        throw error;
      }
    }
    this.update(record, {
      stage: 'cancelled',
      message: '已停止跟踪，服务端仍在处理',
    });
  }

  async refreshReviewStatus(transferId: string): Promise<PluginPublisherProgress | null> {
    const record = this.transfers.get(transferId);
    if (!record) return null;
    if (record.progress.stage !== 'succeeded' || record.progress.reviewStatus !== 'pending') {
      return record.progress;
    }
    const uploadId = record.uploadId;
    if (!uploadId) return record.progress;
    try {
      const status = await this.deps.api.status(uploadId);
      this.applyStatus(record, status);
    } catch {
      // Keep the last snapshot; the next status call can retry.
    }
    return record.progress;
  }

  private async commitWithRetry(
    record: TransferRecord,
    uploadId: string,
    signal: AbortSignal,
  ) {
    let transientRetries = 0;
    while (!signal.aborted) {
      try {
        return await this.deps.api.commit(uploadId);
      } catch (error) {
        if (isTransientPublisherApiError(error)) {
          transientRetries += 1;
          if (transientRetries > PLUGIN_PUBLISHER_POLL_MAX_TRANSIENT_RETRIES) {
            this.fail(record, 'SERVER_BUSY', '服务端繁忙，请稍后重试');
            return 'cancelled';
          }
          this.update(record, { stage: 'committing', message: '服务端繁忙，重试中' });
          await this.sleep(
            PLUGIN_PUBLISHER_POLL_TRANSIENT_BACKOFF_MS * transientRetries,
            signal,
          );
          continue;
        }
        throw error;
      }
    }
    this.update(record, {
      stage: 'cancelled',
      message: '已停止跟踪，服务端仍在处理',
    });
    return 'cancelled';
  }

  private async putWithRecovery(
    putOnce: () => Promise<{ bytesSent: number }>,
  ): Promise<
    | 'ok'
    | 'commit_same_upload'
    | 'cancelled_incomplete'
    | 'cancelled_uncertain'
    | 'network_unreachable'
  > {
    let retried = false;
    for (;;) {
      try {
        await putOnce();
        return 'ok';
      } catch (error) {
        if (!(error instanceof PluginPublisherPutError)) throw error;
        if (error.disposition === 'commit_same_upload') return 'commit_same_upload';
        if (error.disposition === 'cancelled_incomplete' || error.disposition === 'cancelled_uncertain') {
          return error.disposition;
        }
        if (error.disposition === 'retry_same_url' && !retried) {
          retried = true;
          continue;
        }
        return 'network_unreachable';
      }
    }
  }

  private applyStatus(record: TransferRecord, status: PluginMemberUploadStatusResponse): void {
    const stage: PluginPublisherStage =
      status.status === 'succeeded'
        ? 'succeeded'
        : status.status === 'failed'
          ? 'failed'
          : status.status === 'expired'
            ? 'expired'
            : 'processing';
    this.update(record, {
      uploadId: status.uploadId,
      stage,
      status: status.status,
      reviewStatus: status.reviewStatus,
      ghostId: status.ghostId,
      version: status.version,
      failure: status.failure,
      errorCode: status.failure?.code ?? null,
      message: status.failure?.message ?? (status.status === 'expired' ? '上传会话已过期' : null),
    });
  }

  private fail(record: TransferRecord, errorCode: string, message: string): void {
    this.update(record, { stage: 'failed', errorCode, message });
  }
}

function cancelMessage(commitAlreadySent: boolean): string {
  return commitAlreadySent ? '已停止跟踪，服务端仍在处理' : '已取消发布';
}

function isTerminalStage(stage: PluginPublisherStage): boolean {
  return (
    stage === 'succeeded' ||
    stage === 'failed' ||
    stage === 'expired' ||
    stage === 'cancelled'
  );
}

function isTransientPublisherApiError(error: unknown): boolean {
  if (!(error instanceof PluginPublisherApiError)) return false;
  if (error.status >= 500) return true;
  return (
    error.code === 'RATE_LIMIT_UNAVAILABLE' ||
    error.code === 'STORAGE_UNAVAILABLE' ||
    error.code === 'AUTH_CONTEXT_UNAVAILABLE'
  );
}

function isTerminalPublisherClientError(error: PluginPublisherApiError): boolean {
  return error.status === 403 || error.status === 404;
}

function mapPublisherApiMessage(error: PluginPublisherApiError): string {
  if (error.status === 403 && error.code === 'FORBIDDEN') {
    return '本企业未开启成员发布，请联系管理员';
  }
  if (error.code === 'MEMBERSHIP_INACTIVE') return '当前成员身份已不可用，请联系管理员';
  if (error.code === 'RATE_LIMITED') return '发布次数过多，请稍后再试';
  if (error.status === 403 || error.status === 404) return '找不到这次发布或无权查看';
  return '发布请求失败';
}

function isUnsupportedPrepareEndpoint(error: unknown): boolean {
  if (!(error instanceof PluginPublisherApiError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  // A legacy ingress without this route can surface an HTML 503. Redacted
  // structured service failures retain their own business codes.
  return error.status === 503 && error.code === 'INTERNAL_ERROR';
}

export function createPluginPublisherOrchestrator(
  deps: PluginPublisherOrchestratorDeps,
): PluginPublisherOrchestrator {
  return new PluginPublisherOrchestrator(deps);
}
