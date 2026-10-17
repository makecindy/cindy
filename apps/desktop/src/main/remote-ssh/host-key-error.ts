import type { HostKeyErrorDetails } from '@cindy/maker-remote-ssh';
import { t } from '../i18n.js';

/** Use the current UI language and the store's actual path for SSH repair guidance. */
export function formatHostKeyError(details: HostKeyErrorDetails): string {
  const values: Record<string, string> = {
    host: details.host,
    fingerprint: details.fingerprint ?? '',
    reason: details.reason ?? '',
    filePath: details.filePath ?? '',
  };
  const translate = (key: string): string =>
    t(`settings.remote.hostKeyError.${key}`).replace(
      /\{\{(\w+)\}\}/g,
      (placeholder, name: string) => values[name] ?? placeholder,
    );
  const message = translate(details.kind);
  if (details.kind === 'missing') return message;
  if (details.kind === 'mismatch') {
    return `${message}\n${translate(details.filePath ? 'repair' : 'verifyChange')}`;
  }
  return details.filePath ? `${message}\n${translate('file')}` : message;
}
