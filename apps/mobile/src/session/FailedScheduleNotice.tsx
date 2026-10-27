import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  compareFailedScheduleRuns,
  scheduleFailureMessageKey,
  type FailedScheduleRunSnapshot,
} from '@cindy/maker-shared/schedule-model';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice } from '@/components/ErrorNotice';
import { spacing } from '@/theme/tokens';

/** Only a local display preference: never writes a run or a read receipt. */
export function FailedScheduleNotice({
  source,
  run,
}: {
  source: string;
  run: FailedScheduleRunSnapshot;
}) {
  const key = `scheduleFailureDismissal:${source}`;
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<FailedScheduleRunSnapshot | null>(
    null,
  );
  const { t } = useTranslation();
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setDismissed(null);
    void AsyncStorage.getItem(key)
      .then((raw) => {
        if (!active || !raw) return;
        try {
          const value = JSON.parse(raw);
          if (
            typeof value?.runId === 'string' &&
            typeof value.firedAt === 'number' &&
            Number.isFinite(value.firedAt)
          )
            setDismissed(value);
        } catch {
          /* Invalid preferences do not hide history. */
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [key]);
  if (!loaded || (dismissed && compareFailedScheduleRuns(dismissed, run) >= 0))
    return null;
  const dismiss = () => {
    setDismissed(run);
    void AsyncStorage.setItem(key, JSON.stringify(run)).catch(() => undefined);
  };
  return (
    <ErrorNotice
      style={{ marginTop: spacing.sm }}
      testID="session.failedScheduleNotice"
      message={t(
        `session.failedScheduleNotice.${scheduleFailureMessageKey(run)}`,
      )}
      onDismiss={dismiss}
      dismissLabel={t('session.failedScheduleNotice.dismissTitle')}
    />
  );
}
