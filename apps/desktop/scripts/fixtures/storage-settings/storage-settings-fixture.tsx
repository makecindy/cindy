import { mountPage } from '../../ui-page/harness';
import { StorageManagementCard } from '../../../src/renderer/components/settings/StorageManagementCard';

const GIB = 1024 ** 3;

function Fixture() {
  return (
    <main className="mx-auto max-w-[820px] p-6">
      <StorageManagementCard />
    </main>
  );
}

void mountPage({
  host: {
    platform: 'darwin',
    cindyMediaStorage: {
      reportDraftUrls: () => undefined,
      openLegacyImagesDir: async () => ({ opened: true }),
      clearLegacyImagesDir: async () => ({ cleared: true }),
      openChatAttachmentsDir: async () => ({ opened: true }),
      clearChatAttachmentsDir: async () => ({ cleared: true }),
      stats: async () => ({
        success: true,
        blobs: { totalCount: 412, totalBytes: 268 * 1024 * 1024, cacheCount: 96, cacheBytes: 42 * 1024 * 1024 },
        remoteMedia: { bytes: 128 * 1024 * 1024, fileCount: 64 },
        legacy: { bytes: 0, fileCount: 0 },
        fixedCaches: {
          legacyImages: { bytes: 0, fileCount: 0 },
          chatAttachments: { bytes: 18 * 1024 * 1024, fileCount: 9 },
        },
        deadDirs: [],
      }),
    },
    localDb: {
      maintenance: {
        getLastResult: async () => null,
        scan: async () => null,
        schedule: async () => ({ scheduled: false }),
        chooseBackupDirectory: async () => ({ selected: false }),
        openLastBackupDirectory: async () => ({ opened: false }),
      },
      databaseSizeWarning: {
        getSettings: async () => ({
          thresholdGiB: 10,
          disabled: false,
          isCustomized: false,
          defaultThresholdGiB: 10,
        }),
        getStatus: async () => ({ databaseBytes: 94.6 * GIB }),
        measure: async () => ({ databaseBytes: 94.6 * GIB }),
        onChanged: () => () => undefined,
      },
      // The block under test: automatic cleanup switched on, 30-day retention.
      dbAutoCleanup: {
        getSettings: async () => ({ enabled: true, retentionDays: 30 }),
        setSettings: async (patch) => ({
          enabled: patch?.enabled ?? true,
          retentionDays: patch?.retentionDays ?? 30,
        }),
      },
    },
  },
  render: () => <Fixture />,
});
