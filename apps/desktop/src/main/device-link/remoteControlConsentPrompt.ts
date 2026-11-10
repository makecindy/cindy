import { dialog, type BrowserWindow } from 'electron';
import { t } from '../i18n.desktop.js';
import { consentDisplayText } from './remoteControlConsent.js';

/** Parent-owned native sheet: on macOS an unparented message box ignores AbortSignal. */
export async function promptRemoteControlConsent(
  parent: BrowserWindow | null, device: string, purpose: string, signal: AbortSignal,
): Promise<boolean> {
  if (!parent || parent.isDestroyed() || signal.aborted) throw new Error('Consent window unavailable');
  if (parent.isMinimized()) parent.restore();
  parent.show();
  parent.focus();
  const fields: Record<string, string> = { device: consentDisplayText(device), purpose: consentDisplayText(purpose) };
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question', title: t('remoteControlConsent.title'), message: t('remoteControlConsent.title'),
    detail: t('remoteControlConsent.detail').replace(/\{\{(device|purpose)\}\}/g, (_match, key: string) => fields[key]!),
    buttons: [t('remoteControlConsent.decline'), t('remoteControlConsent.enable')],
    defaultId: 0, cancelId: 0, noLink: true, signal,
  });
  return response === 1 && !signal.aborted;
}
