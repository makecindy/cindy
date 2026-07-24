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

function containsPathOrDescendant(text: string, folderPath: string): boolean {
  let index = text.indexOf(folderPath);
  while (index !== -1) {
    const nextCharacter = text[index + folderPath.length];
    if (
      nextCharacter === undefined ||
      nextCharacter === '/' ||
      nextCharacter === '\\' ||
      nextCharacter === "'" ||
      nextCharacter === '"'
    ) {
      return true;
    }
    index = text.indexOf(folderPath, index + folderPath.length);
  }
  return false;
}

/** Returns the folder kind if a macOS tool result contains EPERM + a protected path. */
export function detectProtectedFolderEperm(
  text: string,
  platform: NodeJS.Platform = process.platform,
): ProtectedFolderKind | null {
  if (platform !== 'darwin' || !EPERM_PATTERNS.test(text)) return null;
  for (const [kind, folderPath] of Object.entries(PROTECTED_PATHS) as [ProtectedFolderKind, string][]) {
    if (containsPathOrDescendant(text, folderPath)) return kind;
  }
  return null;
}

// Shared across agent sessions for this app process. Restarting the app resets it.
const guidanceShownFor = new Set<ProtectedFolderKind>();

/** Opens the matching macOS System Settings panel. Does nothing on other platforms. */
export async function openFolderPrivacySettings(
  kind: ProtectedFolderKind,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return;
  const url = TCC_SETTINGS_URLS[kind];
  log.info('opening folder privacy settings', { kind, url });
  await shell.openExternal(url);
}

/** Reserves the process-lifetime guidance slot for a folder kind. */
export function shouldShowEpermGuidance(kind: ProtectedFolderKind): boolean {
  if (guidanceShownFor.has(kind)) return false;
  guidanceShownFor.add(kind);
  return true;
}

/** Allows a retry when the native dialog failed before it could be shown. */
export function releaseEpermGuidance(kind: ProtectedFolderKind): void {
  guidanceShownFor.delete(kind);
}

export function resetEpermGuidanceForTest(): void {
  guidanceShownFor.clear();
}
