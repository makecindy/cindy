import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AppIcon } from '@cindy/maker-shared';
import { applyAppIcon, readAppIconState, type AppIconState } from '@/platform/appIcon';

export interface AppIconChoice {
  state: AppIconState;
  select(icon: AppIcon): void;
}

/**
 * Null where the installed build cannot switch icons (Android, older builds),
 * so the settings page can leave the row out instead of showing an empty one.
 */
export function useAppIconChoice(): AppIconChoice | null {
  const { t } = useTranslation();
  const [state, setState] = useState<AppIconState | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void readAppIconState().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!state) return null;
  const select = (icon: AppIcon) => {
    // Drop overlapping taps synchronously, including taps before React renders.
    // Only confirmed native state owns the selection; there is no rollback chain.
    if (pendingRef.current || icon === state.current) return;
    pendingRef.current = true;
    void (async () => {
      let confirmed = state;
      try {
        await applyAppIcon(icon);
        confirmed = { ...state, current: icon };
      } catch {
        Alert.alert(
          t('settings.appearance.appIcon.label'),
          t('settings.appearance.appIcon.saveFailed'),
        );
      } finally {
        const actual = await readAppIconState();
        setState(actual ?? confirmed);
        pendingRef.current = false;
      }
    })();
  };
  return { state, select };
}

