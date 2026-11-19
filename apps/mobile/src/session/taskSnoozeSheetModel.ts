import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INDEFINITE_SNOOZE_UNTIL } from '@cindy/maker-shared/live-task-priority';
import { taskSnoozeOptions, formatTaskSnoozeTime } from '@cindy/maker-shared/task-snooze-options';

export interface TaskSnoozeSheetProps {
  visible: boolean;
  onClose(): void;
  onClosed(): void;
  onConfirm(until: string): void;
}

export function useTaskSnoozeSheet(props: TaskSnoozeSheetProps) {
  const { t, i18n } = useTranslation();
  const [openedAt, setOpenedAt] = useState(() => new Date());
  const [custom, setCustom] = useState(false);
  const [date, setDate] = useState<Date | null>(() => new Date(Date.now() + 3_600_000));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!props.visible) return;
    const now = new Date();
    setOpenedAt(now);
    setDate(new Date(now.getTime() + 3_600_000));
    setCustom(false);
    setInvalid(false);
  }, [props.visible]);
  const choose = (value: Date | null) => {
    const ms = value?.getTime() ?? NaN;
    const now = Date.now();
    if (!Number.isFinite(ms) || ms <= now || ms > now + 366 * 86_400_000) {
      setInvalid(true);
      return;
    }
    props.onConfirm(new Date(ms).toISOString());
  };
  return {
    t, custom, setCustom, date, setDate, invalid, choose,
    chooseIndefinite: () => props.onConfirm(INDEFINITE_SNOOZE_UNTIL),
    minimumDate: openedAt,
    maximumDate: new Date(openedAt.getTime() + 366 * 86_400_000),
    options: taskSnoozeOptions(openedAt).map(option => ({
      ...option,
      label: t(`devices.list.menu.inbox.${option.hours ? 'hours' : option.id}`, { count: option.hours }),
      time: formatTaskSnoozeTime(option, openedAt, i18n.language),
    })),
  };
}
