import { useTranslation } from 'react-i18next';
import { RotateCcw, ImagePlus, Film } from 'lucide-react';
import { useEffect, useCallback, useState } from 'react';
import { extractIpcError } from '@/utils/ipcError';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Slider } from '@/components/ui/slider';
import { DesktopCompanionSection } from './DesktopCompanionSection';
import { cn } from '@/lib/utils';
import { useWallpaperSettings } from '@/hooks/useWallpaperSettings';
import { useDesktopCompanionSettings } from '@/hooks/useDesktopCompanionSettings';
import { getBuiltinWallpaperBackground, isSceneWallpaper } from '@/lib/wallpaper';
import {
  APPEARANCE_LIMITS,
  DEFAULT_APPEARANCE_SETTINGS,
  isCustomWallpaperVideo,
  type WallpaperId,
} from '@/../shared/appearanceSettings';

const WALLPAPER_OPTIONS: Array<{ id: WallpaperId }> = [
  { id: 'none' },
  { id: 'cindy-window' },
  { id: 'cindy-studio' },
  { id: 'cindy-dream' },
  { id: 'memory' },
];

export function WallpaperSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { previewDataUrl, setEnabled } = useDesktopCompanionSettings();
  const {
    wallpaperId,
    wallpaperOverlay,
    wallpaperVisibility,
    wallpaperBlur,
    visibility,
    wallpaperMotion,
    customWallpaperUrl,
    playbackFailed,
    setWallpaper,
    setVisibility,
    setBlur,
    previewBlur,
    setMotion,
    resetWallpaper,
  } = useWallpaperSettings();
  // The shared slider restores its starting value during cancellation. Clear
  // that temporary preview after its handler, returning to the latest saved value.
  const cancelBlurPreview = useCallback(() => {
    queueMicrotask(() => previewBlur(null));
  }, [previewBlur]);
  useEffect(() => {
    window.addEventListener('blur', cancelBlurPreview);
    return () => {
      window.removeEventListener('blur', cancelBlurPreview);
      previewBlur(null);
    };
  }, [cancelBlurPreview, previewBlur]);
  const customVideo = isCustomWallpaperVideo(customWallpaperUrl);
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
    <div
      id="settings-search-settings-appearance-wallpaper"
      className={cn(
        'flex flex-col gap-4 rounded-xl border p-5',
        'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-13 font-medium text-[var(--settings-section-sublabel)]">
            {t('settings.appearance.wallpaper.title')}
          </h3>
          <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.appearance.wallpaper.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="lg"
          className="shrink-0 px-3"
          type="button"
          onClick={resetWallpaper}
          disabled={
            busy ||
            (wallpaperId === DEFAULT_APPEARANCE_SETTINGS.wallpaperId &&
              wallpaperOverlay === DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay &&
              wallpaperVisibility == null &&
              wallpaperBlur == null &&
              wallpaperMotion === DEFAULT_APPEARANCE_SETTINGS.wallpaperMotion)
          }
        >
          <RotateCcw size={14} />
          <span>{t('settings.appearance.wallpaper.reset')}</span>
        </Button>
      </div>

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
        role="radiogroup"
        aria-label={t('settings.appearance.wallpaper.aria')}
      >
        {[...WALLPAPER_OPTIONS, { id: 'custom' as const }].map((option) => {
          const selected = wallpaperId === option.id;
          const background =
            option.id === 'memory' && previewDataUrl
              ? `url("${previewDataUrl}")`
              : option.id === 'custom' && customWallpaperUrl && !customVideo
              ? `url("${customWallpaperUrl}")`
              : getBuiltinWallpaperBackground(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t('settings.appearance.wallpaper.options.' + option.id)}
              disabled={busy}
              onClick={() =>
                option.id === 'memory'
                  ? (void setEnabled(true), setWallpaper('memory'))
                  : option.id === 'custom' && !customWallpaperUrl
                  ? void chooseWallpaper()
                  : setWallpaper(option.id)
              }
              className={cn(
                'flex min-w-0 flex-col gap-2 rounded-xl text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon-active)]',
              )}
            >
              <span
                className={cn(
                  'relative h-16 overflow-hidden rounded-xl border bg-[var(--settings-input-bg)]',
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
                {option.id === 'custom' && customVideo ? (
                  <span className="absolute inset-0 flex items-center justify-center text-[var(--settings-section-sublabel)]">
                    <Film size={22} aria-hidden="true" />
                  </span>
                ) : null}
                {option.id === 'custom' && !customWallpaperUrl ? (
                  <span className="absolute inset-0 flex items-center justify-center text-[var(--settings-section-sublabel)]">
                    <ImagePlus size={22} aria-hidden="true" />
                  </span>
                ) : null}
                {option.id === 'none' ? (
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
                {t('settings.appearance.wallpaper.options.' + option.id)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
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
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => void removeWallpaper()}
          >
            {t('settings.appearance.wallpaper.customRemove')}
          </Button>
        )}
        <p className="text-12 text-[var(--settings-section-sublabel)]">
          {t('settings.appearance.wallpaper.customHint')}
        </p>
      </div>
      {(error || (wallpaperId === 'custom' && playbackFailed)) && (
        <p role="alert" className="text-12 text-[var(--text-primary)]">
          {error || t('settings.appearance.wallpaper.customPlaybackFailed')}
        </p>
      )}

      <div className="h-px bg-[var(--settings-input-border)]" />

      <div className="flex flex-col gap-3">
        {(isSceneWallpaper(wallpaperId) || (wallpaperId === 'custom' && customVideo)) && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.appearance.wallpaper.motionLabel')}
              </p>
              <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.appearance.wallpaper.motionHint')}
              </p>
            </div>
            <SegmentedControl
              aria-label={t('settings.appearance.wallpaper.motionLabel')}
              value={wallpaperMotion}
              onValueChange={setMotion}
              options={[
                { value: 'static', label: t('settings.appearance.wallpaper.motionStatic') },
                { value: 'dynamic', label: t('settings.appearance.wallpaper.motionDynamic') },
              ]}
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-12 text-[var(--settings-section-sublabel)]">
            {t('settings.appearance.wallpaper.visibilityLabel')}
          </span>
          <Slider
            min={APPEARANCE_LIMITS.wallpaperVisibility.min}
            max={APPEARANCE_LIMITS.wallpaperVisibility.max}
            step={APPEARANCE_LIMITS.wallpaperVisibility.step}
            value={[visibility]}
            onValueChange={([value]) => {
              if (typeof value === 'number') setVisibility(value);
            }}
            aria-label={t('settings.appearance.wallpaper.visibilityLabel')}
            aria-describedby="wallpaper-visibility-hint"
          />
          <span className="w-10 shrink-0 text-right font-mono text-12 text-[var(--settings-section-sublabel)]">
            {Math.round(visibility * 100)}%
          </span>
        </div>
        <p
          id="wallpaper-visibility-hint"
          className="text-12 text-[var(--settings-section-sublabel)]"
        >
          {t('settings.appearance.wallpaper.visibilityHint')}
        </p>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-12 text-[var(--settings-section-sublabel)]">
            {t('settings.appearance.wallpaper.blurLabel')}
          </span>
          <Slider
            min={APPEARANCE_LIMITS.wallpaperBlur.min}
            max={APPEARANCE_LIMITS.wallpaperBlur.max}
            step={APPEARANCE_LIMITS.wallpaperBlur.step}
            value={[wallpaperBlur ?? 0]}
            disabled={wallpaperId === 'none'}
            onValueChange={([value]) => {
              if (typeof value === 'number') previewBlur(value);
            }}
            onValueCommit={([value]) => {
              if (typeof value === 'number') setBlur(value);
            }}
            onPointerCancel={cancelBlurPreview}
            onLostPointerCapture={cancelBlurPreview}
            aria-label={t('settings.appearance.wallpaper.blurLabel')}
            aria-describedby="wallpaper-blur-hint"
          />
          <span className="w-10 shrink-0 text-right font-mono text-12 text-[var(--settings-section-sublabel)]">
            {wallpaperBlur ?? 0}
          </span>
        </div>
        <p id="wallpaper-blur-hint" className="text-12 text-[var(--settings-section-sublabel)]">
          {t('settings.appearance.wallpaper.blurHint')}
        </p>
      </div>
      <DesktopCompanionSection />
    </div>
  );
}
