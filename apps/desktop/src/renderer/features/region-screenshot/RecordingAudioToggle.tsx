import { CircleAlert, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Muted is a selectable state, not an unavailable device. */
export function RecordingAudioToggle({ source, enabled, onChange, compact = false, disabled = false, error }: {
  source: 'system' | 'microphone';
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  compact?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const label = t(`regionScreenshot.live.${source === 'system' ? 'systemAudio' : 'microphone'}`);
  const Icon = source === 'system' ? (enabled ? Volume2 : VolumeX) : (enabled ? Mic : MicOff);
  return <Button size="sm" variant="secondary" tone="quiet"
    className={`${compact ? 'h-7 w-7 px-0' : 'h-14 min-w-20 flex-col gap-1 px-3 text-12'} ${enabled ? 'text-[var(--text-primary)]' : ''}`}
    aria-label={label} aria-pressed={enabled} title={error ? t(`regionScreenshot.live.${error}`) : label}
    disabled={disabled} onClick={() => onChange(!enabled)}>
    <span className="relative flex items-center justify-center" aria-hidden="true">
      <Icon size={compact ? 16 : 20} />
      {error && <CircleAlert size={12} className="absolute -bottom-1 -right-1 rounded-full bg-[var(--surface-elevated)] text-[var(--warning-accent)]" />}
    </span>
    {!compact && <span>{label}</span>}
  </Button>;
}
