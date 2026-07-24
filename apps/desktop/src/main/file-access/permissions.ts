import { homedir } from 'node:os';
import path from 'node:path';
import { shell } from 'electron';

import { createLogger } from '../logger.js';

const log = createLogger('file-access-permissions');

export type ProtectedFolderKind = 'Desktop' | 'Documents' | 'Downloads';

const PROTECTED_PATHS: Record<ProtectedFolderKind, string> = {
  Desktop: path.join(homedir(), 'Desktop'),
  Documents: path.join(homedir(), 'Documents'),
  Downloads: path.join(homedir(), 'Downloads'),
};

const TCC_SETTINGS_URLS: Record<ProtectedFolderKind, string> = {
  Desktop:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder',
  Documents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder',
  Downloads:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DownloadsFolder',
};

const EPERM_PATTERNS = /operation not permitted|eperm/i;

/** Returns the folder kind if the text contains EPERM + a protected path. */
export function detectProtectedFolderEperm(text: string): ProtectedFolderKind | null {
  if (!EPERM_PATTERNS.test(text)) return null;
  for (const [kind, folderPath] of Object.entries(PROTECTED_PATHS) as [ProtectedFolderKind, string][]) {
    if (text.includes(folderPath)) return kind;
  }
  return null;
}

const guidanceShownFor = new Set<ProtectedFolderKind>();

/** Opens the macOS System Settings panel for the given protected folder. */
export async function openFolderPrivacySettings(kind: ProtectedFolderKind): Promise<void> {
  const url = TCC_SETTINGS_URLS[kind];
  log.info('opening folder privacy settings', { kind, url });
  await shell.openExternal(url);
}

/**
 * Shows guidance once per folder kind per app session.
 * Returns true if guidance was shown, false if already shown.
 */
export function shouldShowEpermGuidance(kind: ProtectedFolderKind): boolean {
  if (guidanceShownFor.has(kind)) return false;
  guidanceShownFor.add(kind);
  return true;
}

export function resetEpermGuidanceForTest(): void {
  guidanceShownFor.clear();
}
