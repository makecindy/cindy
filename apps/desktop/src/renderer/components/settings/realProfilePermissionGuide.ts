import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';

export const MAC_FULL_DISK_ACCESS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export const REAL_PROFILE_CONFIRM_TITLE_KEY = 'settings.computerUse.realProfile.confirmTitle';
export const REAL_PROFILE_CONFIRM_DESCRIPTION_KEY =
  'settings.computerUse.realProfile.confirmDescription';
export const REAL_PROFILE_CONFIRM_DESCRIPTION_MAC_KEY =
  'settings.computerUse.realProfile.confirmDescriptionMac';
export const REAL_PROFILE_CONFIRM_ACTION_KEY = 'settings.computerUse.realProfile.confirm';

type Translate = (key: string) => string;

type OpenExternal = (url: string) => Promise<{ success: boolean }>;

export function isMacFullDiskAccessPlatform(platform: string | undefined): boolean {
  return platform === 'darwin';
}

export function realProfileEnableDescriptionKey(
  platform: string | undefined,
): typeof REAL_PROFILE_CONFIRM_DESCRIPTION_MAC_KEY | typeof REAL_PROFILE_CONFIRM_DESCRIPTION_KEY {
  return isMacFullDiskAccessPlatform(platform)
    ? REAL_PROFILE_CONFIRM_DESCRIPTION_MAC_KEY
    : REAL_PROFILE_CONFIRM_DESCRIPTION_KEY;
}

export function realProfileEnableConfirmOptions(
  platform: string | undefined,
  t: Translate,
): ConfirmOptions {
  return {
    title: t(REAL_PROFILE_CONFIRM_TITLE_KEY),
    description: t(realProfileEnableDescriptionKey(platform)),
    confirmText: t(REAL_PROFILE_CONFIRM_ACTION_KEY),
    confirmVariant: 'destructive',
  };
}

export async function openMacFullDiskAccessSettings(
  openExternal: OpenExternal,
): Promise<boolean> {
  const opened = await openExternal(MAC_FULL_DISK_ACCESS_SETTINGS_URL);
  return opened.success === true;
}

/**
 * Keep consent to use a signed-in profile separate from macOS folder access.
 * Offer Settings only when the actual profile read was denied.
 */
export async function confirmEnableRealProfile(options: {
  platform: string | undefined;
  t: Translate;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
  openExternal: OpenExternal;
  onOpenSettingsFailed?: (result: unknown) => void;
  canReadSourceProfile?: () => Promise<boolean | undefined>;
}): Promise<boolean> {
  const confirmed = options.confirm
    ? await options.confirm(realProfileEnableConfirmOptions(options.platform, options.t))
    : true;
  if (!confirmed) return false;
  if (isMacFullDiskAccessPlatform(options.platform)) {
    // A missing bridge or failed IPC says nothing about filesystem authorization.
    const readable = await options.canReadSourceProfile?.().catch(() => undefined);
    if (readable === false) {
      await guideFullDiskAccessAfterReadDenied(options);
    }
  }
  return true;
}

/** Fail-closed recovery when a later snapshot hits TCC. */
export async function guideFullDiskAccessAfterReadDenied(options: {
  platform: string | undefined;
  t: Translate;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
  openExternal: OpenExternal;
  onOpenSettingsFailed?: (result: unknown) => void;
}): Promise<void> {
  const isMac = isMacFullDiskAccessPlatform(options.platform);
  const confirmed = options.confirm
    ? await options.confirm({
        title: options.t('settings.computerUse.realProfile.readDeniedTitle'),
        description: options.t('settings.computerUse.realProfile.readDeniedDescription'),
        confirmText: options.t('settings.computerUse.realProfile.openFullDiskAccess'),
        cancelText: options.t('settings.computerUse.realProfile.readDeniedLater'),
        autoFocusConfirm: true,
      })
    : true;
  if (!confirmed || !isMac) return;
  const opened = await openMacFullDiskAccessSettings(options.openExternal);
  if (!opened) options.onOpenSettingsFailed?.({ success: false });
}
