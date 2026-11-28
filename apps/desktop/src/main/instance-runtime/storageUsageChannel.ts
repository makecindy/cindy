import {
  CLOUD_STORAGE_USAGE_CHANNEL,
  cloudStorageUsageRequestSchema,
  type CloudStorageUsage,
} from '../../shared/cloudStorageUsage.js';
import type { SettingsOwnerStamp } from '../../shared/hostSettings.js';
import type { ManagementExecution } from '../host-settings/management.js';

export interface StorageUsageChannelDeps {
  /** The managed instance exists and its signed-in member is the instance owner. */
  isInstanceOwner(): boolean;
  owner(): SettingsOwnerStamp | null;
  /** The instance's storage handlers through the closed cloud management call set. */
  call(channel: string, args: unknown[], execution: ManagementExecution): Promise<unknown>;
  /** Total and free bytes of the volume holding Cindy's data. */
  disk(): Promise<{ totalBytes: number; freeBytes: number }>;
  timeoutMs?: number;
}

const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};
const size = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * The owner's cloud storage page reads the same totals as the local storage page, plus the
 * instance disk. Read-only: only byte counts cross, never paths or file names.
 */
export function createStorageUsageChannel(deps: StorageUsageChannelDeps) {
  const ownerAtIngress = (): SettingsOwnerStamp => {
    if (!deps.isInstanceOwner()) fail('PERMISSION_DENIED', 'not the instance owner');
    return deps.owner() ?? fail('OWNER_CHANGED', 'the instance account is changing');
  };
  const execution = (owner: SettingsOwnerStamp): ManagementExecution => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 30_000);
    return {
      signal,
      assertCurrent() {
        if (signal.aborted) fail('TIMEOUT', 'request timed out');
        const now = deps.isInstanceOwner() ? deps.owner() : null;
        if (
          !now ||
          now.dataOwnerId !== owner.dataOwnerId ||
          now.ownerGeneration !== owner.ownerGeneration
        )
          fail('OWNER_CHANGED', 'the instance account changed');
      },
      prompt() {
        fail('UNSUPPORTED', 'storage usage is read-only');
      },
      onCancel(cancel) {
        signal.addEventListener('abort', cancel, { once: true });
      },
    };
  };
  return {
    channel: CLOUD_STORAGE_USAGE_CHANNEL,
    async handle(_controller: string, raw: unknown): Promise<CloudStorageUsage> {
      const owner = ownerAtIngress();
      if (!cloudStorageUsageRequestSchema.safeParse(raw).success)
        fail('INVALID_PARAMS', 'invalid storage usage request');
      const run = execution(owner);
      // One failed measurement leaves its figure unknown, like the local page.
      const [media, database, disk] = await Promise.allSettled([
        deps.call('cindy-media:storage-stats', [], run),
        deps.call('database-size-warning:measure', [], run),
        deps.disk(),
      ]);
      run.assertCurrent();
      const stats = media.status === 'fulfilled' ? record(media.value) : {};
      const ok = stats.success === true;
      const caches = record(stats.fixedCaches);
      const total = disk.status === 'fulfilled' ? size(disk.value.totalBytes) : null;
      const free = disk.status === 'fulfilled' ? size(disk.value.freeBytes) : null;
      return {
        version: 1,
        ownerGeneration: owner.ownerGeneration,
        disk:
          total && free !== null && free <= total ? { totalBytes: total, freeBytes: free } : null,
        databaseBytes:
          database.status === 'fulfilled' ? size(record(database.value).databaseBytes) : null,
        mediaBytes: ok ? size(record(stats.blobs).totalBytes) : null,
        legacyImagesBytes: ok ? size(record(caches.legacyImages).bytes) : null,
        chatAttachmentsBytes: ok ? size(record(caches.chatAttachments).bytes) : null,
      };
    },
  };
}
