import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SPEAKER_GATE_STRICTNESS_VALUES,
  SPEAKER_MODEL_TOTAL_BYTES,
  type SpeakerGateStrictness,
} from '@cindy/voice-input-core';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useVoiceSpeakerFilterStatus } from '@/hooks/useVoiceSpeakerFilterStatus';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { VoiceSpeakerEnrollmentDialog } from './VoiceSpeakerEnrollmentDialog';
import type { VoiceSpeakerFilterStatus } from '../../../shared/voiceSpeakerFilter';

const log = createLogger('VoiceSpeakerFilterCard');

interface VoiceSpeakerFilterCardProps {
  enabled: boolean;
  strictness: SpeakerGateStrictness;
  strictnessCustomized: boolean;
  microphoneDeviceId: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onStrictnessChange: (strictness: SpeakerGateStrictness) => void;
  onStrictnessReset: () => Promise<boolean>;
}

/**
 * "Recognize my voice": the switch, the one-time model download, the voiceprint
 * and the strictness. The filter only takes effect when it is on, the models
 * are downloaded and a voiceprint is enrolled; the card says what is missing.
 */
export function VoiceSpeakerFilterCard({
  enabled,
  strictness,
  strictnessCustomized,
  microphoneDeviceId,
  onEnabledChange,
  onStrictnessChange,
  onStrictnessReset,
}: VoiceSpeakerFilterCardProps) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { status, setStatus } = useVoiceSpeakerFilterStatus();
  const [enrolling, setEnrolling] = useState(false);
  const supported = status?.supported !== false;

  const runStatusAction = (action: () => Promise<VoiceSpeakerFilterStatus>): void => {
    void action()
      .then(setStatus)
      .catch((error) => {
        log.warn('speaker filter action failed:', error instanceof Error ? error.message : String(error));
        toast.error(t('settings.voiceInput.speakerFilter.actionFailed'));
      });
  };

  const downloadModels = (): void => runStatusAction(() => window.electronAPI.voiceInput.speakerFilter.downloadModels());

  const toggle = (next: boolean): void => {
    onEnabledChange(next);
    // The models are fetched the first time the user turns the filter on.
    if (next && status && (status.modelState === 'missing' || status.modelState === 'failed')) {
      downloadModels();
    }
  };

  const deleteProfile = async (): Promise<void> => {
    const confirmed = await confirm({
      presentation: 'standard',
      title: t('settings.voiceInput.speakerFilter.profile.deleteConfirm.title'),
      description: t('settings.voiceInput.speakerFilter.profile.deleteConfirm.description'),
      confirmText: t('settings.voiceInput.speakerFilter.profile.deleteConfirm.confirm'),
      cancelText: t('settings.voiceInput.speakerFilter.profile.deleteConfirm.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    void window.electronAPI.voiceInput.speakerFilter
      .deleteProfile()
      .then((next) => {
        setStatus(next);
        toast.success(t('settings.voiceInput.speakerFilter.profile.deleted'));
      })
      .catch((error) => {
        log.warn('speaker profile delete failed:', error instanceof Error ? error.message : String(error));
        toast.error(t('settings.voiceInput.speakerFilter.actionFailed'));
      });
  };

  const showDetails = supported && status !== null && (enabled || status.enrolled);
  const modelsReady = status?.modelState === 'ready';
  if (window.electronAPI.platform !== 'darwin' && window.electronAPI.platform !== 'win32') return null;

  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-xl p-4',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <h3
        className="text-13 font-medium text-[var(--settings-section-sublabel)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {t('settings.voiceInput.sections.speakerFilter')}
      </h3>

      <div className="flex items-center justify-between gap-5">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            id="settings-search-settings-voiceInput-speakerFilter-label"
            className="text-13 font-medium text-[var(--settings-section-title)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.voiceInput.speakerFilter.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {supported
              ? t('settings.voiceInput.speakerFilter.hint')
              : t('settings.voiceInput.speakerFilter.unsupported')}
          </p>
        </div>
        <Switch
          checked={enabled && supported}
          disabled={!supported || status === null}
          onCheckedChange={toggle}
          aria-label={t('settings.voiceInput.speakerFilter.ariaLabel')}
        />
      </div>

      {showDetails && status ? (
        // Every row gets the same hairline the other voice-input rows use.
        <div
          className={cn(
            'flex flex-col gap-4 border-t border-[var(--settings-theme-card-border)] pt-4',
            '[&>*+*]:border-t [&>*+*]:border-[var(--settings-theme-card-border)] [&>*+*]:pt-4',
          )}
        >
          {!modelsReady ? <ModelRow status={status} onDownload={downloadModels} /> : null}

          {modelsReady ? (
            <div className="flex items-center justify-between gap-5">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-13 font-medium text-[var(--settings-section-title)]">
                  {t(
                    status.enrolled
                      ? 'settings.voiceInput.speakerFilter.profile.enrolled'
                      : 'settings.voiceInput.speakerFilter.profile.missing',
                  )}
                </p>
                <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                  {status.enrolled && status.enrolledAt
                    ? t('settings.voiceInput.speakerFilter.profile.enrolledAt', {
                        date: new Date(status.enrolledAt).toLocaleDateString(i18n.language),
                      })
                    : t('settings.voiceInput.speakerFilter.profile.missingHint')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {status.enrolled ? (
                  <Button
                    variant="secondary"
                    size="md"
                    compact
                    tone="quiet"
                    type="button"
                    onClick={() => {
                      void deleteProfile();
                    }}
                  >
                    {t('settings.voiceInput.speakerFilter.profile.delete')}
                  </Button>
                ) : null}
                <Button variant="secondary" size="md" compact type="button" onClick={() => setEnrolling(true)}>
                  {t(
                    status.enrolled
                      ? 'settings.voiceInput.speakerFilter.profile.reenroll'
                      : 'settings.voiceInput.speakerFilter.profile.enroll',
                  )}
                </Button>
              </div>
            </div>
          ) : status.enrolled ? (
            <div className="flex items-center justify-between gap-5">
              <p className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.voiceInput.speakerFilter.profile.enrolled')}
              </p>
              <Button
                variant="secondary"
                size="md"
                compact
                tone="quiet"
                type="button"
                onClick={() => {
                  void deleteProfile();
                }}
              >
                {t('settings.voiceInput.speakerFilter.profile.delete')}
              </Button>
            </div>
          ) : null}

          {status.enrolled ? (
            <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
              <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1">
                <p className="text-13 font-medium text-[var(--settings-section-title)]">
                  {t('settings.voiceInput.speakerFilter.strictness.label')}
                </p>
                <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                  {t('settings.voiceInput.speakerFilter.strictness.hint')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <DefaultOverrideControls
                  isCustomized={strictnessCustomized}
                  onReset={() => {
                    void onStrictnessReset().then((ok) => {
                      if (ok) toast.success(t('settings.defaults.restored'));
                    });
                  }}
                />
                <SegmentedControl
                  aria-label={t('settings.voiceInput.speakerFilter.strictness.label')}
                  value={strictness}
                  onValueChange={onStrictnessChange}
                  options={SPEAKER_GATE_STRICTNESS_VALUES.map((value) => ({
                    value,
                    label: t(`settings.voiceInput.speakerFilter.strictness.options.${value}`),
                  }))}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {supported ? (
        <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {t('settings.voiceInput.speakerFilter.privacy')}
        </p>
      ) : null}

      <VoiceSpeakerEnrollmentDialog
        open={enrolling}
        onOpenChange={setEnrolling}
        microphoneDeviceId={microphoneDeviceId}
        onEnrolled={setStatus}
      />
    </section>
  );
}

function ModelRow({ status, onDownload }: { status: VoiceSpeakerFilterStatus; onDownload: () => void }) {
  const { t } = useTranslation();
  const total = formatMegabytes(status.totalBytes || SPEAKER_MODEL_TOTAL_BYTES);

  if (status.modelState === 'downloading') {
    return (
      <div className="flex items-center justify-between gap-5">
        <p className="flex min-w-0 items-center gap-2 text-13 text-[var(--settings-section-title)]">
          <Spinner size={14} aria-hidden />
          {t('settings.voiceInput.speakerFilter.model.downloading', {
            done: formatMegabytes(status.downloadedBytes),
            total,
          })}
        </p>
        <Button
          variant="secondary"
          size="md"
          compact
          type="button"
          onClick={() => {
            void window.electronAPI.voiceInput.speakerFilter.cancelDownload();
          }}
        >
          {t('settings.voiceInput.speakerFilter.model.cancel')}
        </Button>
      </div>
    );
  }

  const failed = status.modelState === 'failed';
  return (
    <div className="flex items-center justify-between gap-5">
      <p
        role={failed ? 'alert' : undefined}
        className={cn(
          'min-w-0 text-12 leading-[1.4]',
          failed ? 'text-[var(--error-fg)]' : 'text-[var(--settings-section-sublabel)]',
        )}
      >
        {failed
          ? t(`settings.voiceInput.speakerFilter.model.failed.${status.downloadError ?? 'network'}`)
          : t('settings.voiceInput.speakerFilter.model.needed', { size: total })}
      </p>
      <Button variant="secondary" size="md" compact type="button" onClick={onDownload}>
        {t(failed ? 'settings.voiceInput.speakerFilter.model.retry' : 'settings.voiceInput.speakerFilter.model.download')}
      </Button>
    </div>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
