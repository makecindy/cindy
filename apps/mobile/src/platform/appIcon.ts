import { requireOptionalNativeModule } from 'expo-modules-core';
import {
  APP_ICONS,
  appIconAlternateName,
  appIconFromAlternateName,
  type AppIcon,
} from '@cindy/maker-shared';

interface NativeAppIconState {
  supported: boolean;
  current: string | null;
  available: string[];
  darkArtwork: boolean;
}

interface NativeAppIcon {
  getState(): Promise<NativeAppIconState>;
  setIcon(name: string | null): Promise<void>;
}

export interface AppIconState {
  /** Choices this installed build can show, in the shared display order. */
  icons: AppIcon[];
  current: AppIcon;
  /** Whether this system can show the dark artwork (iOS 18+ home screen icon styles). */
  darkArtwork: boolean;
}

function nativeAppIcon(): NativeAppIcon | null {
  try {
    return requireOptionalNativeModule<NativeAppIcon>('CindyAppIcon');
  } catch {
    return null;
  }
}

/**
 * The shared icon list arrives with JavaScript updates, the icons themselves
 * only with a native build: offer what both sides know. Null hides the
 * setting (Android, older builds, devices that cannot switch icons).
 */
export function resolveAppIconState(native: NativeAppIconState): AppIconState | null {
  if (!native.supported) return null;
  const available = new Set(native.available);
  const icons = APP_ICONS.filter((icon) => {
    const name = appIconAlternateName(icon);
    return name === null || available.has(name);
  });
  if (icons.length < 2) return null;
  const current = appIconFromAlternateName(native.current);
  return {
    icons,
    current: icons.includes(current) ? current : icons[0],
    darkArtwork: native.darkArtwork,
  };
}

export async function readAppIconState(): Promise<AppIconState | null> {
  const native = nativeAppIcon();
  if (!native) return null;
  try {
    return resolveAppIconState(await native.getState());
  } catch {
    return null;
  }
}

/** Rejects when iOS refuses the change; the system shows its own confirmation. */
export async function applyAppIcon(icon: AppIcon): Promise<void> {
  const native = nativeAppIcon();
  if (!native) throw new Error('App icons are not available in this build');
  await native.setIcon(appIconAlternateName(icon));
}
