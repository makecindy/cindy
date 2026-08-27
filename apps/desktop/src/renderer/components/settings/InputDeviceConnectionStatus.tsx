import { cn } from '@/lib/utils';

export type InputDeviceConnectionTone = 'connected' | 'error' | 'neutral';

/**
 * Shared connection status for input-device rows (Work Louder, Xbox, …).
 *
 * DESIGN.md treats these as Micro Label status badges, and status dots are the
 * sanctioned way to carry hue. One device must not invent a text-only variant.
 */
export function InputDeviceConnectionStatus({
  label,
  tone,
  compact = false,
}: {
  label: string;
  tone: InputDeviceConnectionTone;
  compact?: boolean;
}) {
  const dotClass =
    tone === 'connected'
      ? 'bg-[var(--settings-badge-connected)]'
      : tone === 'error'
        ? 'bg-[var(--error-fg)]'
        : 'bg-[var(--text-tertiary)]';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full text-12 text-[var(--text-secondary)]',
        compact
          ? 'px-1.5 py-1'
          : 'border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] px-2.5 py-1.5',
      )}
    >
      <span className={cn('size-1.5 rounded-full', dotClass)} aria-hidden="true" />
      {label}
    </span>
  );
}

export type InputDeviceStatusKey =
  | 'connecting'
  | 'connected'
  | 'not-detected'
  | 'present'
  | 'disabled'
  | 'error'
  | 'unavailable';

export function resolveInputDeviceStatusKey(input: {
  enabled: boolean;
  present: boolean | null | undefined;
  connectionStatus?: string | null;
  loading?: boolean;
}): InputDeviceStatusKey {
  if (input.loading) return 'connecting';
  if (!input.enabled) return 'disabled';
  if (input.connectionStatus === 'error' || input.connectionStatus === 'unavailable') {
    return input.connectionStatus;
  }
  if (input.present === false || input.connectionStatus === 'not-detected') return 'not-detected';
  if (input.present === true || input.connectionStatus === 'connected') return 'connected';
  return 'connecting';
}

export function inputDeviceStatusLabelKey(status: InputDeviceStatusKey): InputDeviceStatusKey {
  return status === 'present' ? 'connected' : status;
}

export function inputDeviceConnectionTone(input: {
  status: string;
  present?: boolean | null;
}): InputDeviceConnectionTone {
  if (input.status === 'error' || input.status === 'unavailable') return 'error';
  if (input.present === true || input.status === 'connected' || input.status === 'present') {
    return 'connected';
  }
  return 'neutral';
}
