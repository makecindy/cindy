import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewScheduleFirstFire, type ScheduleFormState } from '../lib/scheduleFormLogic';

/** A creation estimate; the scheduler computes the final timestamp when saving. */
export function ScheduleTimingPreview({ form }: { form: ScheduleFormState }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  let next: number | undefined;
  let when: string | undefined;
  let invalid = false;
  try {
    next = previewScheduleFirstFire(form, now);
    if (next !== undefined) {
      when = new Intl.DateTimeFormat(i18n.language, {
        timeZone: form.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(next);
    }
  } catch {
    invalid = true;
  }

  return (
    <div className="space-y-1 text-xs text-[var(--text-secondary)]" role="status">
      <p>{t('scheduler.editor.timing.timezone', { timezone: form.timezone })}</p>
      <p>
        {invalid ? t('scheduler.editor.timing.invalid') : next === undefined
          ? t('scheduler.editor.timing.none')
          : <time dateTime={new Date(next).toISOString()}>
              {t('scheduler.editor.timing.next', { when })}
            </time>}
      </p>
    </div>
  );
}
