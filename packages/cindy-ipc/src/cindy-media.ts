export const CINDY_MEDIA_CHANNELS = {
  REPORT_DRAFT_URLS: "cindy-media:report-draft-urls",
  STORAGE_CLEANUP: "cindy-media:storage-cleanup",
  STORAGE_RECONCILE: "cindy-media:storage-reconcile",
  STORAGE_SCAN: "cindy-media:storage-scan",
  STORAGE_STATS: "cindy-media:storage-stats",
} as const;

export type CINDY_MEDIAChannel = typeof CINDY_MEDIA_CHANNELS[keyof typeof CINDY_MEDIA_CHANNELS];
