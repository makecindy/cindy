import type { IpcMainInvokeEvent } from 'electron';

import { MAX_CLIPBOARD_TEXT_CHARS } from '../shared/textClipboard.js';
import { requireObject, throwIpcError } from './utils/ipcValidate.js';

/** Native clipboard dependencies keep validation testable without Electron. */
interface TextClipboardDependencies {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  assertFocusedSender: (event: IpcMainInvokeEvent) => void;
  write: (text: string) => void | Promise<void>;
  read: () => string | undefined | Promise<string | undefined>;
}

const issuedClipboardText = new Map<string, number>();

/** Record Main-issued text; non-expiring public links stay valid for this process. */
export function rememberIssuedClipboardText(text: string, expiresAt?: string): void {
  const expiresAtMs = expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiresAt);
  if (!text || Number.isNaN(expiresAtMs)) return;
  issuedClipboardText.set(text, expiresAtMs);
}

export function clearIssuedClipboardText(): void {
  issuedClipboardText.clear();
}

function isLiveIssuedClipboardText(text: string): boolean {
  const expiresAtMs = issuedClipboardText.get(text);
  if (expiresAtMs == null) return false;
  if (expiresAtMs <= Date.now()) {
    issuedClipboardText.delete(text);
    return false;
  }
  return true;
}

/**
 * Report success only after the system clipboard reads back the exact text.
 * Wayland compositors can drop a write silently, so a resolved write alone is
 * not proof that other apps (or a remote desktop viewer) will see it.
 */
export async function copyTextToClipboard(
  event: IpcMainInvokeEvent,
  input: unknown,
  deps: TextClipboardDependencies,
): Promise<void> {
  deps.assertTrustedSender(event);
  deps.assertFocusedSender(event);
  const { text } = requireObject(input);
  if (typeof text !== 'string' || !text || text.length > MAX_CLIPBOARD_TEXT_CHARS) {
    throwIpcError('INVALID_PARAMS', 'Invalid clipboard text');
  }
  if (!isLiveIssuedClipboardText(text)) {
    throwIpcError('PERMISSION_DENIED', 'Clipboard text was not issued by Main');
  }
  let actual: string | undefined;
  try {
    await deps.write(text);
    actual = await deps.read();
  } catch {
    throwIpcError('INTERNAL', 'Unable to write text to clipboard');
  }
  if (actual !== text) throwIpcError('INTERNAL', 'Clipboard did not keep the copied text');
}
