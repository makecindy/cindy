import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DownloadMeter, type DownloadMeterProgress } from './DownloadMeter';

/** One visibility rule for both runtimes: installed items only appear in search;
 * active/paused/failed downloads stay visible, once, even while searching. */
export function localModelBrowserItems<T>({
  catalog,
  featured,
  active,
  query,
  matches,
  isInstalled,
}: {
  catalog: readonly T[];
  featured: readonly T[];
  active: readonly T[];
  query: string;
  matches: (entry: T, query: string) => boolean;
  isInstalled: (entry: T) => boolean;
}) {
  const q = query.trim().toLowerCase();
  const available = (entry: T) => !isInstalled(entry) || active.includes(entry);
  const base = q ? catalog.filter((entry) => matches(entry, q)) : featured.filter(available);
  const visible = [...new Set([...active, ...base])];
  const more = q ? [] : catalog.filter((entry) => !visible.includes(entry) && available(entry));
  return { visible, more };
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

export function LocalDownloadActions({
  active,
  paused,
  onPause,
  onCancel,
  onResume,
}: {
  active: boolean;
  paused?: boolean;
  onPause?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  if (!active) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {paused && onResume ? (
        <IconAction label={t('settings.providers.local.resumeDownload')} onClick={onResume}>
          <Play size={13} fill="currentColor" />
        </IconAction>
      ) : onPause ? (
        <IconAction label={t('settings.providers.local.pauseDownload')} onClick={onPause}>
          <Pause size={13} fill="currentColor" />
        </IconAction>
      ) : null}
      {onCancel && (
        <IconAction label={t('settings.providers.local.cancelDownload')} onClick={onCancel}>
          <X size={14} />
        </IconAction>
      )}
    </div>
  );
}

/** Shared presentation extracted from Ollama; runtime adapters own transport and state. */
export function LocalModelCard({
  name,
  packaging,
  badge,
  description,
  details,
  actions,
  progress,
}: {
  name: string;
  packaging?: ReactNode;
  badge?: ReactNode;
  description?: string;
  details?: ReactNode;
  actions: ReactNode;
  progress?: ReactNode;
}) {
  return (
    <article
      className="flex flex-col gap-3 rounded-[12px] border px-4 py-3.5"
      style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-elevated)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-14 font-medium leading-tight"
              style={{ color: 'var(--settings-section-title)' }}
            >
              {name}
            </span>
            {packaging}
            {badge && <LocalModelTag>{badge}</LocalModelTag>}
          </div>
          {description && (
            <span className="text-12 leading-snug" style={{ color: 'var(--text-secondary)' }}>
              {description}
            </span>
          )}
          {details}
        </div>
        {actions}
      </div>
      {progress}
    </article>
  );
}
export function LocalModelTag({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-11 font-medium"
      style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
    >
      {children}
    </span>
  );
}
export function LocalModelDownloadButton({
  installed,
  failed,
  disabled,
  onClick,
  label,
}: {
  installed?: boolean;
  failed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return installed ? (
    <span className="shrink-0 pt-0.5 text-12" style={{ color: 'var(--text-tertiary)' }}>
      {t('settings.providers.local.alreadyInstalled')}
    </span>
  ) : (
    <Button
      variant="secondary"
      size="md"
      compact
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="shrink-0"
    >
      {t(
        failed ? 'settings.providers.local.retryDownload' : 'settings.providers.local.downloadAdd',
      )}
    </Button>
  );
}
export const localModelInputClass =
  'h-9 min-w-0 rounded-full border px-4 text-13 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]';
export const localModelInputStyle = {
  borderColor: 'var(--border-default)',
  backgroundColor: 'var(--surface-elevated)',
  color: 'var(--settings-section-title)',
};
export function LocalModelBrowser<T>({
  id,
  query,
  onQuery,
  summary,
  visible,
  more,
  renderCard,
}: {
  id: string;
  query: string;
  onQuery: (value: string) => void;
  summary: ReactNode;
  visible: readonly T[];
  more: readonly T[];
  renderCard: (entry: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const searching = query.trim().length > 0;
  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t(
              searching
                ? 'settings.providers.local.searchResults'
                : 'settings.providers.local.recommendedForThisDevice',
            )}
          </span>
          {!searching && summary}
        </div>
        <input
          id={id}
          aria-label={t('settings.providers.local.searchPlaceholder')}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t('settings.providers.local.searchPlaceholder')}
          className={localModelInputClass}
          style={localModelInputStyle}
        />
        {searching && visible.length === 0 && (
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.local.noSearchResults')}
          </span>
        )}
        {visible.map(renderCard)}
      </section>
      {!searching && more.length > 0 && (
        <section className="flex flex-col gap-3">
          <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.local.moreModels')}
          </span>
          {more.map(renderCard)}
        </section>
      )}
    </>
  );
}
export function LocalModelManualDownload({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  onSubmit,
  children,
  buttonLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  onSubmit: () => void;
  children?: ReactNode;
  buttonLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3">
      <span className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
        {t('settings.providers.local.manualDownload')}
      </span>
      <div className="flex gap-2">
        <input
          id={id}
          aria-label={t('settings.providers.local.manualDownload')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${localModelInputClass} flex-1 font-mono text-12`}
          style={localModelInputStyle}
        />
        <Button variant="secondary" size="lg" type="button" disabled={disabled} onClick={onSubmit}>
          {buttonLabel ?? t('settings.providers.local.downloadAdd')}
        </Button>
      </div>
      {children}
    </section>
  );
}
export function LocalRuntimeInstallView({
  description,
  progress,
  canInstall,
  installing,
  onInstall,
  onCancel,
  label,
}: {
  description: string;
  progress?: DownloadMeterProgress;
  canInstall: boolean;
  installing: boolean;
  onInstall: () => void;
  onCancel: () => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-13 leading-[1.5]" style={{ color: 'var(--text-secondary)' }}>
        {description}
      </p>
      {progress && <DownloadMeter progress={progress} />}
      <div className="flex flex-wrap gap-2">
        {canInstall && (
          <Button
            variant="cta"
            size="lg"
            loading={installing}
            type="button"
            disabled={installing}
            onClick={onInstall}
          >
            {label ?? t('settings.providers.local.installInCindy')}
          </Button>
        )}
        {installing && (
          <Button variant="secondary" size="lg" type="button" onClick={onCancel}>
            {t('settings.providers.local.installCancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
