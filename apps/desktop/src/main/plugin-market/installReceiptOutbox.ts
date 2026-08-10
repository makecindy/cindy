import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { isValidPluginResourceId } from '@cindy/plugin-protocol';

import { createLogger } from '../logger.js';
import {
  atomicWriteFileSync,
  readAtomicFileSync,
} from '../utils/atomicWriteFile.js';

const log = createLogger('plugin-market-install-receipts');

const RECEIPT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_PENDING_RECEIPTS = 256;
const DEFAULT_MAX_RECEIPTS_PER_FLUSH = 16;
const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1_000] as const;
const EVENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_FILE_RE = new RegExp(`^(${EVENT_ID_RE.source.slice(1, -1)})\\.json$`, 'i');

export interface PluginInstallReceipt {
  eventId: string;
  pluginId: string;
  releaseId: string;
}

interface StoredPluginInstallReceipt extends PluginInstallReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
}

export interface PluginInstallReceiptOutboxOptions {
  maxPendingReceipts?: number;
  maxReceiptsPerFlush?: number;
  retryDelaysMs?: readonly number[];
  randomUUID?: () => string;
  wait?: (delayMs: number) => Promise<void>;
  /** Owner switch/logout 时停止发送，文件留给该 owner 下次激活后补发。 */
  shouldSend?: () => boolean;
}

type ReceiptSender = (receipt: PluginInstallReceipt) => Promise<void>;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function errorKind(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

function storedReceipt(value: unknown): StoredPluginInstallReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof receipt.eventId !== 'string' ||
    !EVENT_ID_RE.test(receipt.eventId) ||
    typeof receipt.pluginId !== 'string' ||
    !isValidPluginResourceId(receipt.pluginId) ||
    typeof receipt.releaseId !== 'string' ||
    receipt.releaseId.length === 0 ||
    receipt.releaseId.length > 256
  ) {
    return null;
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    eventId: receipt.eventId.toLowerCase(),
    pluginId: receipt.pluginId,
    releaseId: receipt.releaseId,
  };
}

/**
 * 成功安装回执的窄 outbox。
 *
 * 每个 eventId 一个 owner-scoped 文件，避免与安装账本 schema 耦合，也避免两个
 * Cindy 实例并发整份重写队列时丢掉彼此的新事件。单轮只处理有限条目、每条只做
 * 有限次重试；最终失败保留文件，等下次市场同步或应用重启补发。它不是通用遥测队列。
 */
export class PluginInstallReceiptOutbox {
  private readonly maxPendingReceipts: number;
  private readonly maxReceiptsPerFlush: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly randomUUID: () => string;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly shouldSend: () => boolean;
  private flushInFlight: Promise<void> | null = null;
  private flushRequested = false;

  constructor(
    private readonly directory: string,
    private readonly send: ReceiptSender,
    options: PluginInstallReceiptOutboxOptions = {},
  ) {
    this.maxPendingReceipts = options.maxPendingReceipts ?? DEFAULT_MAX_PENDING_RECEIPTS;
    this.maxReceiptsPerFlush = options.maxReceiptsPerFlush ?? DEFAULT_MAX_RECEIPTS_PER_FLUSH;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    this.wait = options.wait ?? wait;
    this.shouldSend = options.shouldSend ?? (() => true);
  }

  /** 本地安装已提交后才调用；落盘失败只丢本次指标，不改变安装结果。 */
  enqueue(pluginId: string, releaseId: string): PluginInstallReceipt | null {
    try {
      const files = this.receiptFiles();
      if (files.length >= this.maxPendingReceipts) {
        log.warn('plugin install receipt outbox is full', {
          pending: files.length,
        });
        return null;
      }
      const receipt: StoredPluginInstallReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        eventId: this.randomUUID().toLowerCase(),
        pluginId,
        releaseId,
      };
      atomicWriteFileSync(
        path.join(this.directory, `${receipt.eventId}.json`),
        `${JSON.stringify(receipt)}\n`,
      );
      return {
        eventId: receipt.eventId,
        pluginId: receipt.pluginId,
        releaseId: receipt.releaseId,
      };
    } catch (error) {
      log.warn('plugin install receipt could not be queued', {
        errorKind: errorKind(error),
      });
      return null;
    }
  }

  /** 同进程重复触发合并为一轮；网络失败不会向安装/市场调用方外抛。 */
  flush(): Promise<void> {
    this.flushRequested = true;
    if (this.flushInFlight) return this.flushInFlight;
    const current = this.flushLoop()
      .catch((error) => {
        log.warn('plugin install receipt flush failed', {
          errorKind: errorKind(error),
        });
      })
      .finally(() => {
        if (this.flushInFlight === current) this.flushInFlight = null;
      });
    this.flushInFlight = current;
    return current;
  }

  /** 测试与诊断用的只读 pending 投影。 */
  pending(): PluginInstallReceipt[] {
    return this.readPending().map(({ receipt }) => receipt);
  }

  private async flushPending(): Promise<void> {
    if (!this.shouldSend()) return;
    const pending = this.readPending().slice(0, this.maxReceiptsPerFlush);
    for (const entry of pending) {
      if (!this.shouldSend()) return;
      let delivered = false;
      for (const delayMs of this.retryDelaysMs) {
        if (!this.shouldSend()) return;
        if (delayMs > 0) await this.wait(delayMs);
        try {
          await this.send(entry.receipt);
          delivered = true;
          break;
        } catch (error) {
          log.warn('plugin install receipt delivery failed', {
            eventId: entry.receipt.eventId,
            errorKind: errorKind(error),
          });
        }
      }
      if (!delivered) continue;
      try {
        fs.rmSync(entry.filePath, { force: true });
      } catch (error) {
        // 服务端已按 eventId 接收；删失败时保留文件，后续重复发送由服务端幂等去重。
        log.warn('delivered plugin install receipt could not be cleared', {
          eventId: entry.receipt.eventId,
          errorKind: errorKind(error),
        });
      }
    }
  }

  private receiptFiles(): string[] {
    try {
      return fs
        .readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && RECEIPT_FILE_RE.test(entry.name))
        .map((entry) => path.join(this.directory, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private readPending(): Array<{ receipt: PluginInstallReceipt; filePath: string }> {
    const pending: Array<{
      receipt: PluginInstallReceipt;
      filePath: string;
      modifiedAt: number;
    }> = [];
    for (const filePath of this.receiptFiles()) {
      try {
        const text = readAtomicFileSync(filePath);
        let parsed: StoredPluginInstallReceipt | null = null;
        try {
          parsed = text === null ? null : storedReceipt(JSON.parse(text));
        } catch {
          parsed = null;
        }
        const fileEventId = path.basename(filePath, '.json').toLowerCase();
        if (!parsed || parsed.eventId !== fileEventId) {
          log.warn('invalid plugin install receipt discarded', { eventId: fileEventId });
          fs.rmSync(filePath, { force: true });
          continue;
        }
        pending.push({
          receipt: {
            eventId: parsed.eventId,
            pluginId: parsed.pluginId,
            releaseId: parsed.releaseId,
          },
          filePath,
          modifiedAt: fs.statSync(filePath).mtimeMs,
        });
      } catch (error) {
        log.warn('plugin install receipt could not be read', {
          eventId: path.basename(filePath, '.json'),
          errorKind: errorKind(error),
        });
      }
    }
    pending.sort((left, right) => left.modifiedAt - right.modifiedAt);
    return pending;
  }

  private async flushLoop(): Promise<void> {
    do {
      this.flushRequested = false;
      await this.flushPending();
    } while (this.flushRequested && this.shouldSend());
  }
}
