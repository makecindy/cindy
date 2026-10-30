import { inputHandoffQrContent, type InputHandoffQr } from '@cindy/device-link';

/**
 * What a QR code on the target says, as shown to the owner (scan-to-sign-in).
 * A link opens on the owner's device the way a phone camera would open the
 * scanned code: web links (http or https) and app links (`weixin://…`).
 * Script, inline data and local files are shown as text only.
 */
export function qrContent(text: string): InputHandoffQr | null {
  return inputHandoffQrContent(text);
}
