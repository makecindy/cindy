import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LlamaCppCatalogEntry,
  LlamaCppDownloadInput,
  LlamaCppModel,
  LlamaCppSnapshot,
} from '../../../shared/llamaCpp';
import { DownloadMeter, formatDownloadBytes, type DownloadMeterProgress } from './DownloadMeter';
import {
  LocalDownloadActions,
  LocalModelBrowser,
  LocalModelCard,
  LocalModelDownloadButton,
  LocalModelTag,
  localModelBrowserItems,
} from './LocalModelDownloadUI';

export interface LlamaCppDownloadState {
  input: LlamaCppDownloadInput;
  progress: DownloadMeterProgress;
  failed?: boolean;
}
export const sameLlamaCppDownload = (a: LlamaCppDownloadInput, b: LlamaCppDownloadInput) =>
  a.repo === b.repo && a.file === b.file;

/** Transport adapter only: Ollama owns the shared catalog/card/download presentation. */
export function LlamaCppCandidates({
  catalog,
  models,
  locked,
  onDownload,
  download,
  onCancel,
  onPause,
  onResume,
  recommendation,
}: {
  catalog: LlamaCppCatalogEntry[];
  models: LlamaCppModel[];
  locked: boolean;
  onDownload: (input: LlamaCppDownloadInput) => void;
  download?: LlamaCppDownloadState;
  onCancel?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  recommendation?: LlamaCppSnapshot['recommendation'];
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const activeEntries = download
    ? catalog.filter((entry) => entry.variants.some((v) => sameLlamaCppDownload(v, download.input)))
    : [];
  const featured = (recommendation?.featuredIds ?? []).flatMap((id) => {
    const entry = catalog.find((entry) => entry.id === id);
    return entry ? [entry] : [];
  });
  const primary = featured[0];
  const isInstalled = (entry: LlamaCppCatalogEntry) =>
    entry.variants.every((variant) => models.some((model) => sameLlamaCppDownload(model, variant)));
  const nextRecommendation = featured.find((entry) => !isInstalled(entry));
  const lists = localModelBrowserItems({
    catalog,
    featured,
    active: activeEntries,
    query,
    isInstalled,
    matches: (entry, text) =>
      [entry.name, ...entry.aliases, ...entry.variants.map((v) => `${v.repo}/${v.file}`)].some(
        (s) => s.toLowerCase().includes(text),
      ),
  });
  const renderCard = (entry: LlamaCppCatalogEntry) =>
    entry.variants.map((variant) => {
      const installed = models.some((model) => sameLlamaCppDownload(model, variant));
      const current =
        download && sameLlamaCppDownload(download.input, variant) ? download : undefined;
      if (!searching && installed && !current) return null;
      return (
        <LocalModelCard
          key={`${entry.id}/${variant.repo}/${variant.file}`}
          name={entry.name}
          badge={
            !searching && featured.includes(entry)
              ? t(
                  entry.id === primary?.id
                    ? 'settings.providers.llamacpp.primaryPick'
                    : 'settings.providers.local.lighterAlternative',
                )
              : undefined
          }
          packaging={<LocalModelTag>{variant.quantization}</LocalModelTag>}
          description={
            entry.descriptions?.[
              (i18n.resolvedLanguage ?? i18n.language) as keyof NonNullable<
                typeof entry.descriptions
              >
            ] ?? entry.descriptions?.en
          }
          details={
            <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
              {formatDownloadBytes(variant.sizeBytes)}
            </span>
          }
          actions={
            current && !current.failed ? (
              <LocalDownloadActions
                active
                paused={current.progress.paused}
                onCancel={onCancel}
                onPause={onPause}
                onResume={onResume}
              />
            ) : (
              <LocalModelDownloadButton
                installed={installed}
                failed={current?.failed}
                disabled={locked}
                onClick={() => onDownload({ repo: variant.repo, file: variant.file })}
              />
            )
          }
          progress={current && <DownloadMeter progress={current.progress} />}
        />
      );
    });
  return (
    <LocalModelBrowser
      id="llamacpp-model-search"
      query={query}
      onQuery={setQuery}
      visible={lists.visible}
      more={lists.more}
      renderCard={renderCard}
      summary={
        <>
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {recommendation?.memoryGb
              ? t(
                  recommendation.appleSilicon
                    ? 'settings.providers.local.hostProfileApple'
                    : 'settings.providers.local.hostProfileGeneric',
                  { memory: recommendation.memoryGb },
                )
              : t('settings.providers.local.hostProfileUnknown')}
            {recommendation?.chip ? ` · ${recommendation.chip}` : ''}
          </span>
          <span className="text-12 leading-snug" style={{ color: 'var(--text-secondary)' }}>
            {nextRecommendation
              ? t('settings.providers.llamacpp.recommendReason', { name: nextRecommendation.name })
              : primary
                ? t('settings.providers.local.recommendedInstalled')
                : t('settings.providers.local.noRecommendation')}
          </span>
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t(
              primary
                ? 'settings.providers.llamacpp.recommendCaveat'
                : 'settings.providers.llamacpp.trialNote',
            )}
          </span>
        </>
      }
    />
  );
}
