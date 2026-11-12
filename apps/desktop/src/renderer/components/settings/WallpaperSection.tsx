import { appearanceSettings } from './AppearanceSection.settings-search';
import { ErrorNotice } from '@/components/ui/error-notice';
import { useTranslation } from 'react-i18next';
import { RotateCcw, ImagePlus, Film } from 'lucide-react';
import { useEffect, useCallback, useId, useRef, useState } from 'react';
import { extractIpcError } from '@/utils/ipcError';
import { downloadPercent } from './DownloadMeter';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useWallpaperSettings } from '@/hooks/useWallpaperSettings';
import { getBuiltinWallpaperPreview, isCdnWallpaper, isSceneWallpaper } from '@/lib/wallpaper';
import {
  APPEARANCE_LIMITS,
  DEFAULT_APPEARANCE_SETTINGS,
  isCustomWallpaperVideo,
  RETIRED_WALLPAPER_IDS,
  SELECTABLE_WALLPAPER_IDS,
  type WallpaperId,
} from '@/../shared/appearanceSettings';
import { SETTINGS_HINT, SettingsBlock, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

export function WallpaperSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedbackId = useId();
  const buttons = useRef(new Map<WallpaperId, HTMLButtonElement>());
  const [focusedWallpaperId, setFocusedWallpaperId] = useState<WallpaperId | null>(null);
  const {
    customizedKeys,
    wallpaperId,
    wallpaperOverlay,
    wallpaperVisibility,
    wallpaperBlur,
    lastBlur,
    visibility,
    wallpaperMotion,
    customWallpaperUrl,
    playbackFailed,
    downloadPending,
    downloadFailed,
    downloadProgress,
    retryDownload,
    setWallpaper,
    setVisibility,
    previewVisibility,
    setBlur,
    previewBlur,
    setMotion,
    resetWallpaper,
  } = useWallpaperSettings();
  // A retired wallpaper stays visible (and selected) only while it is in use.
  const retiredInUse = RETIRED_WALLPAPER_IDS.find((id) => id === wallpaperId);
  const pickerIds: readonly WallpaperId[] = retiredInUse
    ? [SELECTABLE_WALLPAPER_IDS[0], retiredInUse, ...SELECTABLE_WALLPAPER_IDS.slice(1)]
    : SELECTABLE_WALLPAPER_IDS;
  const entryId = focusedWallpaperId ?? pickerIds.find((id) => id === wallpaperId) ?? pickerIds[0];
  // The shared slider restores its starting value during cancellation. Clear
  // that temporary preview after its handler, returning to the latest saved value.
  const cancelBlurPreview = useCallback(() => {
    queueMicrotask(() => previewBlur(null));
  }, [previewBlur]);
  const cancelVisibilityPreview = useCallback(() => {
    queueMicrotask(() => previewVisibility(null));
  }, [previewVisibility]);
  useEffect(() => {
    const cancelPreviews = () => {
      cancelBlurPreview();
      cancelVisibilityPreview();
    };
    window.addEventListener('blur', cancelPreviews);
    return () => {
      window.removeEventListener('blur', cancelPreviews);
      previewBlur(null);
      previewVisibility(null);
    };
  }, [cancelBlurPreview, cancelVisibilityPreview, previewBlur, previewVisibility]);
  useEffect(() => {
    if (visibility === 0) previewBlur(null);
  }, [visibility, previewBlur]);
  // Windows has a single system Acrylic strength, so desktop blur is on/off there.
  // Artwork blur stays graded; both share wallpaperBlur, so re-enabling restores
  // the last nonzero strength (kept in the provider, which outlives this section).
  const desktopBlurSwitch = wallpaperId === 'none' && window.electronAPI?.platform === 'win32';
  const customVideo = isCustomWallpaperVideo(customWallpaperUrl);
  const downloading = isCdnWallpaper(wallpaperId) && downloadPending;
  const retryable = isCdnWallpaper(wallpaperId) && downloadFailed && !downloadPending;
  const progressRatio = Number.isFinite(downloadProgress)
    ? Math.min(1, Math.max(0, downloadProgress))
    : 0;
  const progressPercent = downloadPercent({ percent: downloadProgress * 100 }) ?? 0;
  const chooseWallpaper = async () => {
    setBusy(true);
    setError('');
    try {
      const selected = await window.electronAPI.appearanceSettings.importWallpaper();
      if (selected) setWallpaper('custom');
    } catch (error) {
      setError(
        t(
          extractIpcError(error)?.code === 'INVALID_PARAMS'
            ? 'settings.appearance.wallpaper.customInvalid'
            : 'settings.appearance.wallpaper.customFailed',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const removeWallpaper = async () => {
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.appearanceSettings.removeWallpaper();
      if (wallpaperId === 'custom') setWallpaper('none');
    } catch {
      setError(t('settings.appearance.wallpaper.customFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="settings-search-target-appearance-wallpaper"
      aria-label={t(appearanceSettings.wallpaperTitle.titleKey)}
      headingLevel={3}
      title={t(appearanceSettings.wallpaperTitle.titleKey)}
      action={
        <Button data-setting-id={appearanceSettings.wallpaperTitle.id}
          variant="secondary"
          size="sm"
          compact
          className="shrink-0"
          type="button"
          onClick={resetWallpaper}
          disabled={
            busy ||
            (customizedKeys
              ? !customizedKeys.some(key => key.startsWith('wallpaper') || key === 'desktopVisibility')
              : wallpaperId === DEFAULT_APPEARANCE_SETTINGS.wallpaperId &&
                wallpaperOverlay === DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay &&
                wallpaperVisibility == null &&
                wallpaperBlur == null &&
                wallpaperMotion === DEFAULT_APPEARANCE_SETTINGS.wallpaperMotion)
          }
        >
          <RotateCcw size={14} aria-hidden />
          <span>{t('settings.appearance.wallpaper.reset')}</span>
        </Button>
      }
    >
      <SettingsCard id={appearanceSettings.wallpaperCustomChoose.targetId}>
        <SettingsBlock className="flex flex-col gap-4">
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2"
            role="radiogroup"
            aria-label={t('settings.appearance.wallpaper.aria')}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWallpaperId(null);
            }}
          >
            {pickerIds.map((id, index) => {
              const selected = wallpaperId === id;
              const label = t('settings.appearance.wallpaper.options.' + id);
              const background =
                id === 'custom' && customWallpaperUrl && !customVideo
                  ? `url("${customWallpaperUrl}")`
                  : getBuiltinWallpaperPreview(id);
              return (
                <Tip
                  key={id}
                  text={
                    selected && retryable
                      ? `${label} · ${t('settings.appearance.wallpaper.downloadFailed')} · ${t('settings.appearance.wallpaper.retryDownload')}`
                      : label
                  }
                >
                  <button data-setting-id={appearanceSettings.wallpaperTitle.id}
                    ref={(button) => {
                      if (button) buttons.current.set(id, button);
                      else buttons.current.delete(id);
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    aria-busy={selected && downloading ? true : undefined}
                    aria-describedby={
                      selected && (downloading || retryable) ? feedbackId : undefined
                    }
                    disabled={busy}
                    tabIndex={!busy && id === entryId ? 0 : -1}
                    onFocus={() => setFocusedWallpaperId(id)}
                    onKeyDown={(event) => {
                      if (busy || event.altKey || event.ctrlKey || event.metaKey) return;
                      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
                      let next: number;
                      switch (event.key) {
                        case 'ArrowRight':
                          next = index + (rtl ? -1 : 1);
                          break;
                        case 'ArrowLeft':
                          next = index + (rtl ? 1 : -1);
                          break;
                        case 'ArrowDown':
                          next = index + 1;
                          break;
                        case 'ArrowUp':
                          next = index - 1;
                          break;
                        case 'Home':
                          next = 0;
                          break;
                        case 'End':
                          next = pickerIds.length - 1;
                          break;
                        default:
                          return;
                      }
                      event.preventDefault();
                      const count = pickerIds.length;
                      const target = pickerIds[(next + count) % count];
                      buttons.current.get(target)?.focus();
                      // An empty custom tile needs explicit activation to open the file picker.
                      if (target !== wallpaperId && (target !== 'custom' || customWallpaperUrl)) {
                        setWallpaper(target);
                      }
                    }}
                    onClick={() => {
                      if (selected && retryable) retryDownload();
                      else if (id === 'custom' && !customWallpaperUrl) void chooseWallpaper();
                      else setWallpaper(id);
                    }}
                    className={cn(
                      'flex min-w-0 flex-col gap-1 rounded-xl text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon-active)]',
                    )}
                  >
                    <span
                      className={cn(
                        'relative aspect-video w-full overflow-hidden rounded-xl border bg-[var(--settings-input-bg)]',
                        selected
                          ? 'border-2 border-[var(--settings-theme-preview-border-active)]'
                          : 'border-[var(--settings-theme-preview-border)]',
                      )}
                      style={{
                        backgroundImage: background,
                        backgroundPosition: 'center',
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: 'cover',
                      }}
                    >
                      {selected && downloading && (
                        <span
                          aria-hidden="true"
                          data-wallpaper-progress="true"
                          className="pointer-events-none absolute inset-x-1.5 bottom-1.5 h-[3px] overflow-hidden rounded-full bg-[var(--surface-chip)]"
                        >
                          <span
                            // Match the downloader's 200ms sampling window without restarting
                            // an ease-in/out on every update. Keep byte precision in the fill.
                            className="absolute inset-0 origin-left bg-[var(--text-primary)] transition-transform duration-[var(--motion-base)] ease-linear motion-reduce:transition-none"
                            style={{ transform: `scaleX(${progressRatio})` }}
                          />
                        </span>
                      )}
                      {selected && retryable && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 flex items-center justify-center"
                        >
                          <span className="flex size-7 items-center justify-center rounded-full bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[shadow:var(--shadow-menu)]">
                            <RotateCcw size={14} />
                          </span>
                        </span>
                      )}
                      {id === 'custom' && customVideo ? (
                        <span className="absolute inset-0 flex items-center justify-center text-[var(--settings-section-sublabel)]">
                          <Film size={22} aria-hidden="true" />
                        </span>
                      ) : null}
                      {id === 'custom' && !customWallpaperUrl ? (
                        <span className="absolute inset-0 flex items-center justify-center text-[var(--settings-section-sublabel)]">
                          <ImagePlus size={22} aria-hidden="true" />
                        </span>
                      ) : null}
                      {id === 'none' ? (
                        <span className="absolute inset-0 flex items-center justify-center text-12 text-[var(--settings-section-sublabel)]">
                          {t('settings.appearance.wallpaper.nonePreview')}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'truncate text-12 font-medium',
                        selected
                          ? 'text-[var(--settings-theme-label-active)]'
                          : 'text-[var(--settings-theme-label)]',
                      )}
                    >
                      {label}
                    </span>
                  </button>
                </Tip>
              );
            })}
          </div>

          {/* Radio descendants are presentational to assistive technology. Keep
              semantic feedback outside the tile while its visible bar stays inside. */}
          {downloading && (
            <div
              id={feedbackId}
              role="progressbar"
              aria-label={t('settings.appearance.wallpaper.downloading')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              className="sr-only"
            >
              {t('settings.appearance.wallpaper.downloading')}
            </div>
          )}
          {retryable && (
            <p id={feedbackId} role="status" className="sr-only">
              {t('settings.appearance.wallpaper.downloadFailed')} ·{' '}
              {t('settings.appearance.wallpaper.retryDownload')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={() => void chooseWallpaper()}
            >
              <ImagePlus size={14} aria-hidden="true" />
              {t(
                `settings.appearance.wallpaper.${busy ? 'customBusy' : customWallpaperUrl ? 'customReplace' : 'customChoose'}`,
              )}
            </Button>
            {customWallpaperUrl && (
              <Button data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
                variant="secondary"
                tone="danger"
                type="button"
                disabled={busy}
                onClick={() => void removeWallpaper()}
              >
                {t('settings.appearance.wallpaper.customRemove')}
              </Button>
            )}
            <p className="text-12 text-[var(--text-secondary)]">
              {t(appearanceSettings.wallpaperCustomChoose.descriptionKey)}
            </p>
          </div>
          {(error || (wallpaperId === 'custom' && playbackFailed)) && (
            <ErrorNotice
              role="alert"
              message={error || t('settings.appearance.wallpaper.customPlaybackFailed')}
            />
          )}
        </SettingsBlock>

        {(isSceneWallpaper(wallpaperId) || (wallpaperId === 'custom' && customVideo)) && (
          <SettingsRow
            title={t('settings.appearance.wallpaper.motionLabel')}
            hint={t('settings.appearance.wallpaper.motionHint')}
            trailing={
              <SegmentedControl data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
                aria-label={t('settings.appearance.wallpaper.motionLabel')}
                value={wallpaperMotion}
                onValueChange={setMotion}
                options={appearanceSettings.wallpaperCustomChoose.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
              />
            }
          />
        )}

        {/* 滑块的名称和数值在同一行，不是设置行 */}
        <SettingsBlock className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-12 text-[var(--settings-section-sublabel)]">
              {t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopVisibilityLabel' : 'settings.appearance.wallpaper.visibilityLabel')}
            </span>
            <Slider data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
              min={APPEARANCE_LIMITS.wallpaperVisibility.min}
              max={APPEARANCE_LIMITS.wallpaperVisibility.max}
              step={APPEARANCE_LIMITS.wallpaperVisibility.step}
              value={[visibility]}
              onValueChange={([value]) => {
                if (typeof value === 'number') previewVisibility(value);
              }}
              onValueCommit={([value]) => {
                if (typeof value === 'number') setVisibility(value);
              }}
              onPointerCancel={cancelVisibilityPreview}
              onLostPointerCapture={cancelVisibilityPreview}
              aria-label={t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopVisibilityLabel' : 'settings.appearance.wallpaper.visibilityLabel')}
              aria-describedby="wallpaper-visibility-hint"
            />
            <span className="w-10 shrink-0 text-right font-mono text-12 text-[var(--settings-section-sublabel)]">
              {Math.round(visibility * 100)}%
            </span>
          </div>
          <p id="wallpaper-visibility-hint" className={SETTINGS_HINT}>
            {t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopVisibilityHint' : 'settings.appearance.wallpaper.visibilityHint')}
          </p>
          {!desktopBlurSwitch && (
            <>
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-12 text-[var(--settings-section-sublabel)]">
                  {t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopBlurLabel' : 'settings.appearance.wallpaper.blurLabel')}
                </span>
                <Slider data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
                  min={APPEARANCE_LIMITS.wallpaperBlur.min}
                  max={APPEARANCE_LIMITS.wallpaperBlur.max}
                  step={APPEARANCE_LIMITS.wallpaperBlur.step}
                  value={[wallpaperBlur ?? 0]}
                  disabled={visibility === 0}
                  onValueChange={([value]) => {
                    if (typeof value === 'number') previewBlur(value);
                  }}
                  onValueCommit={([value]) => {
                    if (typeof value === 'number') setBlur(value);
                  }}
                  onPointerCancel={cancelBlurPreview}
                  onLostPointerCapture={cancelBlurPreview}
                  aria-label={t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopBlurLabel' : 'settings.appearance.wallpaper.blurLabel')}
                  aria-describedby="wallpaper-blur-hint"
                />
                <span className="w-10 shrink-0 text-right font-mono text-12 text-[var(--settings-section-sublabel)]">
                  {wallpaperBlur ?? 0}
                </span>
              </div>
              <p id="wallpaper-blur-hint" className={SETTINGS_HINT}>
                {t(wallpaperId === 'none' ? 'settings.appearance.wallpaper.desktopBlurHint' : 'settings.appearance.wallpaper.blurHint')}
              </p>
            </>
          )}
        </SettingsBlock>
        {desktopBlurSwitch && (
          <SettingsRow
            title={t('settings.appearance.wallpaper.desktopBlurLabel')}
            hint={t('settings.appearance.wallpaper.desktopBlurSwitchHint')}
            trailing={
              <Switch data-setting-id={appearanceSettings.wallpaperCustomChoose.id}
                checked={visibility > 0 && Boolean(wallpaperBlur)}
                disabled={visibility === 0}
                onCheckedChange={(checked) => setBlur(checked ? lastBlur : 0)}
                aria-label={t('settings.appearance.wallpaper.desktopBlurLabel')}
              />
            }
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
