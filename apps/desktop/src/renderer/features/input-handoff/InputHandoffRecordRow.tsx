import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  inputHandoffRecordHost,
  inputHandoffRecordMessage,
  type InputHandoffEndRecord,
} from '@cindy/maker-shared/synthetic-trigger';

/**
 * The one visible trace a 代输入 leaves in the task: who finished how many
 * steps, where, and when. Never values, labels or screen text.
 */
export function InputHandoffRecordRow({ record, at }: { record: InputHandoffEndRecord; at?: string }) {
  const { t, i18n } = useTranslation();
  const message = inputHandoffRecordMessage(record);
  const label = t(`inputHandoff.record.${message.key}`, message.params);
  const host = inputHandoffRecordHost(record.origin);
  const time = at ? formatTime(at, i18n.language) : undefined;
  const text = [label, host, time].filter(Boolean).join(' · ');
  return (
    <div className="flex w-full items-center gap-3 py-2 select-none" role="separator" aria-label={text}>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex min-w-0 shrink items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-11 text-muted-foreground tabular-nums">
        <KeyRound size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{text}</span>
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}

function formatTime(iso: string, locale: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** systemCardData was produced by parseInputHandoffEndRecord; re-check its shape before rendering. */
export function readInputHandoffRecordData(data?: Record<string, unknown>): InputHandoffEndRecord | null {
  if (!data) return null;
  const { status, steps } = data;
  if (!['succeeded', 'cancelled', 'failed', 'expired'].includes(String(status))) return null;
  if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 0) return null;
  return data as unknown as InputHandoffEndRecord;
}
