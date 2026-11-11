import { i18n } from '@/i18n';
import { uploadMobileAttachmentFromFile, discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';

/** Uses the existing phone picker/upload path; provider credentials stay on the Host. */
export async function pickMobileMailAttachment(options: {
  deviceId: string; getAccessToken(): Promise<string | null>; signal: AbortSignal; isActive(): boolean;
  deliver(file: { url: string; name: string }): Promise<boolean>;
}) {
  const picker = await import('expo-document-picker');
  const selected = await picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
  if (selected.canceled || !selected.assets[0]) return null;
  const file = selected.assets[0];
  const fs = await import('expo-file-system/legacy');
  try {
    if (!options.isActive()) return null;
    const info = await fs.getInfoAsync(file.uri);
    const size = info.exists && !info.isDirectory ? info.size : undefined;
    if (size === undefined) throw new Error(i18n.t('plugins.mailAttachFailed'));
    if (size > 16 * 1024 * 1024) throw new Error(i18n.t('plugins.mailAttachTooLarge'));
    const token = await options.getAccessToken();
    if (!options.isActive()) return null;
    const uploaded = await uploadMobileAttachmentFromFile({ name: file.name, size, mimeType: file.mimeType }, file.uri,
      { token, deviceId: options.deviceId, signal: options.signal, isActive: options.isActive });
    let delivered = false;
    try {
      if (!options.isActive()) return null;
      const attachment = { url: uploaded.url || uploaded.path, name: file.name };
      delivered = await options.deliver(attachment);
      return delivered ? attachment : null;
    } finally {
      if (!delivered) discardMobileUploadedAttachment(uploaded, { getToken: () => Promise.resolve(token) });
    }
  } finally { await fs.deleteAsync(file.uri, { idempotent: true }).catch(() => undefined); }
}
