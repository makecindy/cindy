import type { TFunction } from 'i18next';
import type { AuxiliaryDisplayError } from '../../../shared/auxiliaryModelHealth';

export function auxiliaryErrorSummary(error: AuxiliaryDisplayError, t: TFunction): string {
  const status = error.httpStatus;
  if (!status) return t(`settings.auxiliaryModels.healthReasons.${error.reason}`);
  const key = status >= 500 && status < 600 ? 'server'
    : [401, 403, 404, 429].includes(status) ? String(status) : 'other';
  return `HTTP ${status} · ${t(`settings.auxiliaryModels.http.${key}`)}`;
}

export function AuxiliaryErrorDetail({ message }: { message?: string }) {
  if (!message) return null;
  return <span dir="auto" className="block max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{message}</span>;
}
