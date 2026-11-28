import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StorageOverviewView } from '@/components/settings/StorageManagementCard';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { extractIpcError } from '@/utils/ipcError';
import {
  CLOUD_STORAGE_USAGE_CHANNEL,
  cloudStorageUsageSchema,
  type CloudStorageUsage as Usage,
} from '../../../shared/cloudStorageUsage';

/** Below this share of free disk the instance may stop working. */
const LOW_DISK_RATIO = 0.1;

/**
 * Read-only usage of the instance disk and Cindy's data, in the local overview card. Older
 * runtimes without the channel show nothing; cleanup stays on the instance's own page.
 */
export function CloudStorageUsage({
  deviceId,
  name,
  thresholdGiB,
  active,
}: {
  deviceId: string;
  name: string;
  /** The instance's database warning threshold, scaling the bar like the local page. */
  thresholdGiB: number;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported' | 'failed'>('loading');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setStatus((current) => (current === 'unsupported' ? current : 'loading'));
    try {
      const next = cloudStorageUsageSchema.parse(
        await window.electronAPI.deviceLink.invoke(deviceId, CLOUD_STORAGE_USAGE_CHANNEL, [
          { op: 'read' },
        ]),
      );
      if (seq !== sequence.current) return;
      setUsage(next);
      setStatus('ready');
    } catch (error) {
      if (seq !== sequence.current) return;
      const code = extractIpcError(error)?.code;
      setStatus(
        code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'PERMISSION_DENIED'
          ? 'unsupported'
          : 'failed',
      );
    }
  }, [deviceId]);
  useEffect(() => {
    sequence.current++;
    setUsage(null);
    setStatus('loading');
  }, [deviceId]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  if (status === 'unsupported') return null;
  const disk = usage?.disk;
  const low = !!disk && disk.freeBytes / disk.totalBytes < LOW_DISK_RATIO;
  return (
    <StorageOverviewView
      databaseBytes={usage?.databaseBytes ?? null}
      mediaBytes={usage?.mediaBytes ?? null}
      legacyImagesBytes={usage?.legacyImagesBytes ?? null}
      chatAttachmentsBytes={usage?.chatAttachmentsBytes ?? null}
      warningThresholdGiB={thresholdGiB}
      statsFailed={
        status === 'failed' ||
        (!!usage &&
          (usage.databaseBytes === null ||
            usage.mediaBytes === null ||
            usage.legacyImagesBytes === null ||
            usage.chatAttachmentsBytes === null))
      }
      refreshing={status === 'loading'}
      onRefresh={() => void load()}
      title={t('cloudSettings.storageTitle', { name })}
      description={
        disk
          ? t('cloudSettings.storageDisk', {
              used: formatBytes(disk.totalBytes - disk.freeBytes),
              total: formatBytes(disk.totalBytes),
              free: formatBytes(disk.freeBytes),
            })
          : t('cloudSettings.storageDiskUnknown')
      }
      // The bar shows the instance disk, the figure that breaks the instance when full.
      usagePercent={disk ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : null}
      usageLabel={t('cloudSettings.storageDiskLabel')}
    >
      {low && (
        <p role="alert" className="mt-1 text-12 leading-[1.5] text-[var(--warning-fg)]">
          {t('cloudSettings.storageDiskLow')}
        </p>
      )}
    </StorageOverviewView>
  );
}
