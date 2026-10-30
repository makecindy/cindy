import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

/** Optional, bounded failure context. Old receipts/clients keep the broad failure code. */
export interface CindyMakeBuildDiagnostic {
  kind: 'process' | 'outOfMemory' | 'timeout';
  exitCode?: number;
  message?: string;
}

/** Display excerpts never include terminal control codes, credentials or local paths. */
export function sanitizeMakeBuildMessage(value: string): string {
  return redactSensitiveText(
    value
      // Strip OSC (including hyperlinks) before CSI so terminal metadata cannot become text.
      .replace(/\u001b\][^\u0007]*?(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
      .replace(/[A-Za-z]:[\\/][^\r\n"'<>|:[\]]*/g, '<path>')
      .replace(/\\\\[^\r\n"'<>|:[\]]*/g, '<path>')
      .replace(/(^|[\s('"=])(?:~\/|\/)[^\s"'<>|:()[\]]+/gm, '$1<path>'),
  )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s|^\d+:\s+[0-9a-f]{8,}\b/i.test(line))
    .slice(0, 8)
    .join('\n')
    .slice(0, 2000);
}

/** A live status is one bounded line, sanitized before any display truncation. */
export function parseCindyMakeBuildOutput(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32_768) return;
  return sanitizeMakeBuildMessage(value).replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
}

/** Revalidate both saved receipts and thrown diagnostics before displaying or forwarding them. */
export function parseCindyMakeBuildDiagnostic(
  value: unknown,
): CindyMakeBuildDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (data.kind !== 'process' && data.kind !== 'outOfMemory' && data.kind !== 'timeout') return;
  const message =
    typeof data.message === 'string' ? sanitizeMakeBuildMessage(data.message.slice(0, 32_768)) : '';
  return {
    kind: data.kind,
    ...(typeof data.exitCode === 'number' && Number.isSafeInteger(data.exitCode)
      ? { exitCode: data.exitCode }
      : {}),
    ...(message ? { message } : {}),
  };
}
