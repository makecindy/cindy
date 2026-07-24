import { i18n } from '@/i18n';
import { normalizeExtraDirs, parseExtraDirsInput } from '@/session/newSession';

export function formatExtraDirsText(extraDirs: readonly string[] | null | undefined): string {
  return normalizeExtraDirs(extraDirs ?? undefined).join('\n');
}

export function parseSessionExtraDirsDraft(value: string): string[] {
  return parseExtraDirsInput(value);
}

export function appendSessionExtraDirDraft(draft: string, path: string): string {
  const next = [...parseSessionExtraDirsDraft(draft), path];
  return normalizeExtraDirs(next).join('\n');
}

export function hasExtraDirsDraftChanged(
  draft: string,
  current: readonly string[] | null | undefined,
): boolean {
  return !sameStringList(parseSessionExtraDirsDraft(draft), normalizeExtraDirs(current ?? undefined));
}

export function summarizeExtraDirs(extraDirs: readonly string[] | null | undefined): string {
  const count = normalizeExtraDirs(extraDirs ?? undefined).length;
  return count > 0
    ? i18n.t('session.row.extraDirsSummary', { num: count })
    : i18n.t('session.row.noExtraDirsSummary');
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}
