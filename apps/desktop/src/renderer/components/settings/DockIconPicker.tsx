import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import defaultIconUrl from '@/../../resources/icon-dock.png?url';
import catUrl from '@/../../resources/app-icons/cat.png?url';
import markDarkUrl from '@/../../resources/app-icons/mark-dark.png?url';
import markLightUrl from '@/../../resources/app-icons/mark-light.png?url';
import wordmarkDarkUrl from '@/../../resources/app-icons/wordmark-dark.png?url';
import wordmarkLightUrl from '@/../../resources/app-icons/wordmark-light.png?url';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { Tip } from '@/components/ui/tooltip';
import { getInitialAppearanceSettings } from '@/hooks/useFontSettings';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { APP_ICONS, normalizeAppearanceSettings, type AppIcon } from '../../../shared/appearanceSettings';
import { appearanceSettings } from './AppearanceSection.settings-search';

/** Same Dock-ready files main passes to app.dock.setIcon (Apple icon grid baked in). */
const PREVIEWS: Record<AppIcon, { light: string; dark: string }> = {
  default: { light: defaultIconUrl, dark: defaultIconUrl },
  mark: { light: markLightUrl, dark: markDarkUrl },
  wordmark: { light: wordmarkLightUrl, dark: wordmarkDarkUrl },
  cat: { light: catUrl, dark: catUrl },
};

/**
 * macOS Dock icon choice. The 44px tile and its 1.5px inset ring use the 12px
 * container radius; the artwork's grid margin (≈4px) and corner (≈8px) sit
 * concentric inside it.
 */
export function DockIconPicker() {
  const { t } = useTranslation();
  const isDark = useIsDarkMode();
  const [selected, setSelected] = useState<AppIcon>(() => getInitialAppearanceSettings().appIcon);
  const selectedRef = useRef(selected);
  const confirmedRef = useRef(selected);
  const pendingRef = useRef<Array<{ icon: AppIcon }>>([]);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const syncSelection = useCallback(() => {
    const next = pendingRef.current.at(-1)?.icon ?? confirmedRef.current;
    selectedRef.current = next;
    setSelected(next);
  }, []);

  useEffect(
    () =>
      window.electronAPI?.appearanceSettings?.onChanged?.((next) => {
        confirmedRef.current = normalizeAppearanceSettings(next).appIcon;
        syncSelection();
      }),
    [syncSelection],
  );

  const select = (next: AppIcon) => {
    if (next === selectedRef.current) return;
    selectedRef.current = next;
    setSelected(next);
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge) return;
    const request = { icon: next };
    pendingRef.current.push(request);
    // Match font/wallpaper saves: a file-lock retry must not let a newer
    // choice persist first, and older broadcasts must not replace pending UI.
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const saved = await bridge.setPatch({ appIcon: next });
          confirmedRef.current = normalizeAppearanceSettings(saved).appIcon;
        } catch {
          toast.error(t('settings.appearance.appIcon.saveFailed'));
        } finally {
          pendingRef.current = pendingRef.current.filter((pending) => pending !== request);
          syncSelection();
        }
      });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index =
      (APP_ICONS.indexOf(selectedRef.current) + step + APP_ICONS.length) % APP_ICONS.length;
    select(APP_ICONS[index]);
    (event.currentTarget.parentElement?.children[index] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className="flex gap-2" role="radiogroup" aria-label={t('settings.appearance.appIcon.label')}>
      {APP_ICONS.map((icon) => {
        const isSelected = icon === selected;
        const label = t(`settings.appearance.appIcon.options.${icon}`);
        return (
          <Tip key={icon} text={label}>
            <button
              data-setting-id={appearanceSettings.appIcon.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={label}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => select(icon)}
              onKeyDown={handleKeyDown}
              className={cn(
                'size-11 shrink-0 rounded-xl transition-[background-color,box-shadow]',
                // globals.css clears every outline; match the theme cards' box-shadow focus ring.
                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                isSelected
                  ? 'shadow-[inset_0_0_0_1.5px_var(--text-secondary)]'
                  : 'hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <img
                src={isDark ? PREVIEWS[icon].dark : PREVIEWS[icon].light}
                alt=""
                draggable={false}
                className="size-full"
              />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
