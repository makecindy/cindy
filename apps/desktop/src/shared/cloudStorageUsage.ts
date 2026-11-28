import { z } from 'zod';

/**
 * Read-only storage usage of a managed cloud instance, for the same account's cloud settings
 * page: the instance disk is fixed in size and a full disk breaks it. A private DeviceLink
 * channel registered only by the cloud runtime; ordinary desktops and older runtimes answer
 * CHANNEL_NOT_ALLOWED, so the page shows no usage. Cleanup stays on the instance's own page.
 */
export const CLOUD_STORAGE_USAGE_CHANNEL = 'cloud:storage-usage:v1';
/** The instance's own handlers behind this channel (closed cloud management calls). */
export const CLOUD_STORAGE_USAGE_CALLS = [
  'cindy-media:storage-stats',
  'database-size-warning:measure',
] as const;

export const cloudStorageUsageRequestSchema = z.strictObject({ op: z.literal('read') });

const bytes = z.number().int().nonnegative().nullable();
export const cloudStorageUsageSchema = z
  .strictObject({
    version: z.literal(1),
    ownerGeneration: z.number().int().nonnegative(),
    /** The volume holding Cindy's data; null when the instance cannot measure it. */
    disk: z
      .strictObject({
        totalBytes: z.number().int().positive(),
        freeBytes: z.number().int().nonnegative(),
      })
      .nullable(),
    databaseBytes: bytes,
    mediaBytes: bytes,
    legacyImagesBytes: bytes,
    chatAttachmentsBytes: bytes,
  });
export type CloudStorageUsage = z.infer<typeof cloudStorageUsageSchema>;
