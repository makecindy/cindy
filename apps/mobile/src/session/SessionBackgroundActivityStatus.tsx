import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { DeviceLinkError } from '@cindy/device-link';
import type { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTranslation } from 'react-i18next';
import { useThemedStyles } from '@/theme';
import { ComposerActivityPill, makeComposerActivityPillStyles } from './ComposerActivityPill';

const REFRESH_MS = 15_000;

export function SessionBackgroundActivityStatus({
  deviceId,
  sessionId,
  invoke,
}: {
  deviceId: string;
  sessionId: string;
  invoke: ReturnType<typeof useDeviceLink>['invoke'];
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeComposerActivityPillStyles);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const snapshot = await invoke<{ tasks?: unknown } | null>(
          deviceId, 'maker:session-background-tasks:list', [sessionId], {
            background: true,
            preSend: () => {
              if (disposed) throw new Error('Background task status is no longer visible');
            },
          },
        );
        if (!disposed) setCount(Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : 0);
      } catch (error) {
        if (!disposed) setCount(0);
        if (error instanceof DeviceLinkError &&
          (error.code === 'CHANNEL_NOT_ALLOWED' || error.code === 'ACCESS_REVOKED')) return;
      }
      if (!disposed) timer = setTimeout(() => void read(), REFRESH_MS);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [deviceId, invoke, sessionId]);

  if (count === 0) return null;
  return (
    <View pointerEvents="none" style={styles.composerActivityStatus} testID="session.backgroundActivityStatus">
      <ComposerActivityPill label={t('session.screen.backgroundTasksRunning', { taskCount: count })} live />
    </View>
  );
}
