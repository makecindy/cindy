import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Square, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  normalizeVoiceConversationSelection,
  type SpeechModelSelection,
  type SpeechProtocol,
  type SpeechVoiceCatalog,
} from '@/../shared/voiceConversation';
import type { VoicePreviewController } from './VoicePreviewController';
import { readSpeechVoiceLabel, rememberSpeechVoiceLabel } from './speechVoiceLabelCache';
import { SpeechVoiceMenu } from './SpeechVoiceMenu';
import { useBotSettingsTarget } from '../useBotSettingsTarget';

const MANUAL = 'manual';
const LOADING = 'loading';
type CatalogState = {
  routeKey: string;
  phase: 'loading' | 'ready' | 'failed';
  catalog?: SpeechVoiceCatalog;
};
type Props = {
  botId: string;
  route: SpeechModelSelection;
  protocol?: SpeechProtocol;
  voice: string;
  autoSelectFirstVoice: boolean;
  speed?: number;
  children?: ReactNode;
  disabled: boolean;
  previewDisabled: boolean;
  preview: VoicePreviewController;
  onChange(voice: string, save: boolean): void;
};

export function SpeechVoicePicker({
  botId,
  route,
  protocol,
  voice,
  autoSelectFirstVoice,
  speed,
  children,
  disabled,
  previewDisabled,
  preview,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const voiceApi = useBotSettingsTarget().voice;
  const [catalogState, setCatalogState] = useState<CatalogState>();
  const [revision, setRevision] = useState(0);
  const [manualRouteKey, setManualRouteKey] = useState<string>();
  const [previewVoice, setPreviewVoice] = useState<string>();
  const version = useRef(0);
  const owner = getDataOwnerGeneration();
  const selectionRouteKey = JSON.stringify([route, protocol]);
  const routeKey = JSON.stringify([owner.dataOwnerId, owner.generation, botId, selectionRouteKey]);
  // A missing catalog is pending from the first render, not evidence that the
  // saved voice is unavailable. Never reuse another route's list while loading.
  const currentCatalog = catalogState?.routeKey === routeKey ? catalogState : undefined;
  const catalog = currentCatalog?.catalog;
  const loading = !!protocol && (!currentCatalog || currentCatalog.phase === 'loading');
  const failed = currentCatalog?.phase === 'failed';
  const initialLoading = loading && !catalog;
  const manual = manualRouteKey === routeKey;
  const phase = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  const previewing = phase === 'preparing' || phase === 'playing';
  const selection = normalizeVoiceConversationSelection({ ...route, voice, speed });
  const listed = catalog?.voices.some((item) => item.id === voice);
  const cachedLabel = useMemo(
    () => readSpeechVoiceLabel(owner, botId, selectionRouteKey, voice),
    [owner, botId, selectionRouteKey, voice, catalog],
  );
  // A partial private lookup is not evidence that the saved voice was removed.
  // Keep its known label as well as the public choices, without changing the ID.
  const showCachedLabel =
    !!cachedLabel &&
    !listed &&
    ((!catalog && (initialLoading || failed)) || !!catalog?.customVoicesUnavailable);
  const showManual =
    manual ||
    (!initialLoading && !showCachedLabel && ((!!voice && !listed) || !catalog?.voices.length));
  const catalogHint = failed
    ? t('bots.voiceMode.voicesError')
    : catalog?.customVoicesUnavailable
      ? t('bots.voiceMode.voicesCustomError')
      : catalog?.truncated
        ? t('bots.voiceMode.voicesTruncated')
        : catalog?.source === 'reference' || catalog?.source === 'mixed'
          ? t('bots.voiceMode.voicesReference')
          : !initialLoading && !catalog?.voices.length
            ? t('bots.voiceMode.voicesManual')
            : '';
  const voiceOptions = useMemo(() => {
    const voices = (catalog?.voices ?? []).map((item) => ({
      ...item,
      name: item.name.trim() || item.id,
    }));
    const idsByName = new Map<string, string[]>();
    for (const item of voices) {
      const ids = idsByName.get(item.name) ?? [];
      ids.push(item.id);
      idsByName.set(item.name, ids);
    }
    return voices.map((item) => {
      const peers = idsByName.get(item.name)!;
      let label = item.name;
      if (peers.length > 1) {
        // Short IDs only distinguish duplicate labels; selection and storage keep
        // the full provider ID. Extend colliding suffixes until they are distinct.
        let length = 6;
        while (
          length < item.id.length &&
          peers.some((id) => id !== item.id && id.slice(-length) === item.id.slice(-length))
        ) {
          length++;
        }
        label += ` · ${length < item.id.length ? '…' : ''}${item.id.slice(-length)}`;
      }
      return { value: `voice:${item.id}`, label };
    });
  }, [catalog]);

  useEffect(() => {
    const request = ++version.current;
    setCatalogState((current) => ({
      routeKey,
      phase: protocol ? 'loading' : 'ready',
      // Refresh in place. Only an explicit route change discards a known list.
      catalog: protocol && current?.routeKey === routeKey ? current.catalog : undefined,
    }));
    if (protocol) {
      void voiceApi
        .voices(route)
        .then((result) => {
          if (version.current === request && isDataOwnerGenerationCurrent(owner))
            setCatalogState({ routeKey, phase: 'ready', catalog: result });
        })
        .catch(() => {
          if (version.current === request && isDataOwnerGenerationCurrent(owner))
            setCatalogState((current) => ({
              routeKey,
              phase: 'failed',
              catalog: current?.routeKey === routeKey ? current.catalog : undefined,
            }));
        });
    }
    return () => {
      ++version.current;
    };
    // Include the detected protocol in the refresh key, but send only an explicit
    // user override. Main must resolve inferred protocols against its current catalog.
  }, [routeKey, revision]);

  useEffect(() => {
    // Reuse only this route's successful catalog. Manual input, including an
    // intentionally empty draft, always wins over a late catalog response.
    if (
      !autoSelectFirstVoice ||
      voice ||
      manual ||
      disabled ||
      currentCatalog?.phase !== 'ready' ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    const firstVoice = catalog?.voices[0]?.id;
    if (firstVoice) onChange(firstVoice, true);
  }, [autoSelectFirstVoice, voice, manual, disabled, currentCatalog, catalog, owner, onChange]);

  useEffect(() => {
    if (currentCatalog?.phase !== 'ready' || !catalog || !voice) return;
    const label = voiceOptions.find((option) => option.value === `voice:${voice}`)?.label;
    if (catalog.customVoicesUnavailable && !label) return;
    rememberSpeechVoiceLabel(owner, botId, selectionRouteKey, voice, label);
  }, [owner, botId, selectionRouteKey, voice, currentCatalog, catalog, voiceOptions]);

  useEffect(() => {
    setManualRouteKey(undefined);
    void preview.stop();
    return () => {
      void preview.stop();
    };
  }, [routeKey, preview]);
  useEffect(() => {
    void preview.stop();
    setPreviewVoice(undefined);
  }, [voice, speed, preview]);

  const previewOption = (id: string) => {
    if (previewing && previewVoice === id) {
      void preview.stop();
      setPreviewVoice(undefined);
      return;
    }
    const candidate = normalizeVoiceConversationSelection({ ...route, voice: id, speed });
    if (previewDisabled || !protocol || !candidate) return;
    setPreviewVoice(id);
    void preview.start(candidate, t('bots.voiceMode.previewText'));
  };

  return (
    <div className="min-w-0 space-y-3">
      <FormField label={t('bots.voiceMode.voice')}>
        {(control) => (
          <div className="flex min-w-0 items-center gap-2">
            <SpeechVoiceMenu
              key={routeKey}
              {...control}
              label={t('bots.voiceMode.voice')}
              value={
                showManual
                  ? MANUAL
                  : showCachedLabel || listed
                    ? `voice:${voice}`
                    : initialLoading
                      ? LOADING
                      : ''
              }
              options={[
                ...(showCachedLabel
                  ? [{ value: `voice:${voice}`, label: cachedLabel! }, ...voiceOptions]
                  : initialLoading
                    ? [{ value: LOADING, label: t('bots.voiceMode.voicesLoading'), disabled: true }]
                    : voiceOptions),
                { value: MANUAL, label: t('bots.voiceMode.manualVoice') },
              ]}
              disabled={disabled || (initialLoading && !showCachedLabel && !manual)}
              onValueChange={(value) => {
                void preview.stop();
                setManualRouteKey(value === MANUAL ? routeKey : undefined);
                if (value !== MANUAL) onChange(value.slice(6), true);
              }}
              className="min-w-0 flex-1"
              previewVoice={previewVoice}
              previewPhase={phase}
              previewDisabled={previewDisabled || !protocol}
              onPreview={previewOption}
              onOpenChange={() => {
                void preview.stop();
                setPreviewVoice(undefined);
              }}
            />
            <Button
              variant="secondary"
              size="lg"
              className="w-9 shrink-0 px-0"
              aria-label={t('bots.voiceMode.refreshVoices')}
              title={t('bots.voiceMode.refreshVoices')}
              disabled={disabled || loading || !protocol}
              loading={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
          </div>
        )}
      </FormField>
      <p role="status" className={catalogHint ? 'text-12 text-[var(--text-secondary)]' : 'sr-only'}>
        {catalogHint || (loading ? t('bots.voiceMode.voicesLoading') : '')}
      </p>
      {showManual ? (
        <div className="space-y-2">
          <FormField label={t('bots.voiceMode.voiceId')} hint={t('bots.voiceMode.voiceIdHint')}>
            {(control) => (
              <div
                className="flex min-w-0 items-center gap-2"
                onBlur={(event) => {
                  // Auditioning the draft stays inside this field. Saving on the
                  // input's blur would disable the preview before its click lands.
                  if (!event.currentTarget.contains(event.relatedTarget) && selection)
                    onChange(selection.voice, true);
                }}
              >
                <Input
                  {...control}
                  value={voice}
                  maxLength={128}
                  disabled={disabled}
                  onChange={(value) => {
                    void preview.stop();
                    setManualRouteKey(routeKey);
                    onChange(value, false);
                  }}
                  className="min-w-0 flex-1"
                />
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-9 shrink-0 px-0"
                  aria-label={t(
                    previewing ? 'bots.voiceMode.stopPreview' : 'bots.voiceMode.preview',
                  )}
                  title={t(previewing ? 'bots.voiceMode.stopPreview' : 'bots.voiceMode.preview')}
                  disabled={!previewing && (previewDisabled || !selection || !protocol)}
                  onClick={() => {
                    if (previewing) void preview.stop();
                    else if (selection) previewOption(selection.voice);
                  }}
                >
                  {phase === 'preparing' ? (
                    <Spinner size={14} />
                  ) : previewing ? (
                    <Square size={14} aria-hidden="true" />
                  ) : (
                    <Volume2 size={16} aria-hidden="true" />
                  )}
                </Button>
              </div>
            )}
          </FormField>
          <p role="status" className="text-12 text-[var(--text-secondary)]">
            {t(
              phase === 'timeout'
                ? 'bots.voiceMode.errors.speechTimeout'
                : `bots.voiceMode.previewStatus.${phase}`,
            )}
          </p>
        </div>
      ) : null}
      {children}
    </div>
  );
}
