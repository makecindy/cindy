/// <reference path="../../shared/qrcode.d.ts" />
import { nativeImage } from 'electron';
import { toBuffer } from 'qrcode';
import { getInputHandoffService } from '../input-handoff/service.js';
import { isInputHandoffDisabledForSession } from '../input-handoff/botPolicy.js';
import { t } from '../i18n.desktop.js';
import { recoverGoogleAccount, type VerificationUi } from './antigravityVerification.js';

// Encode only the issuer's HTTPS landing page. Google's login and all further verification
// take place in the owner's browser, outside the task and its engine.
async function qrPicture(url: string) {
  const png = await toBuffer(url, { width: 448, margin: 4 });
  const image = nativeImage.createFromBuffer(png);
  return { jpeg: image.toJPEG(94), ...image.getSize(), qr: { text: url, url } };
}

export async function verifyAntigravityAccount(sessionId: string, probe: () => Promise<Record<string, unknown>>, signal: AbortSignal) {
  const service = getInputHandoffService();
  if (!service || await isInputHandoffDisabledForSession(sessionId) || signal.aborted) return 'unavailable' as const;
  const ui: VerificationUi = {
    async card(url, checkAccount, ended) {
      const picture = await qrPicture(url);
      if (signal.aborted) { picture.jpeg.fill(0); return null; }
      const card = service.startAccountVerification({ sessionId, purpose: t('antigravityVerification.title'),
        note: t('antigravityVerification.note'), picture, checkAccount, finished: ended });
      if (!card) { picture.jpeg.fill(0); return null; }
      return { update: async next => card.updateAccountPicture(await qrPicture(next)), verified: () => card.accountVerified(), cancel: () => card.cancel() };
    },
  };
  return recoverGoogleAccount(probe, signal, ui);
}
