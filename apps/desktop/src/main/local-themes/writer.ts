import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';

import type {
  LocalThemeOpenDirResult,
  LocalThemeWriteRequest,
  LocalThemeWriteResult,
} from '../../shared/local-themes';
import { createLogger } from '../logger';
import { getLocalThemesDir } from './loader';

const log = createLogger('local-themes/writer');
const MAX_FILENAME_SUFFIX = 99;

function sanitizeBaseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function findAvailableFilename(
  dir: string,
  baseId: string,
): { filename: string; finalId: string } | null {
  for (let i = 1; i <= MAX_FILENAME_SUFFIX; i += 1) {
    const finalId = i === 1 ? baseId : `${baseId}-${i}`;
    const filename = `${finalId}.json`;
    if (!fs.existsSync(path.join(dir, filename))) {
      return { filename, finalId };
    }
  }
  return null;
}

export async function writeLocalTheme(req: LocalThemeWriteRequest): Promise<LocalThemeWriteResult> {
  try {
    const baseId = sanitizeBaseId(req.baseId);
    if (!baseId) {
      return { success: false, error: 'Invalid baseId after sanitization.' };
    }

    const dir = getLocalThemesDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const slot = findAvailableFilename(dir, baseId);
    if (!slot) {
      return {
        success: false,
        error: `Too many existing copies of '${baseId}' (>${MAX_FILENAME_SUFFIX}).`,
      };
    }

    const themeJson = { ...req.theme, id: slot.finalId };
    const filePath = path.join(dir, slot.filename);
    // Write to a unique temp path then rename — atomic on most filesystems.
    // The random suffix prevents races between concurrent writes to the same slot.
    const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, `${JSON.stringify(themeJson, null, 2)}\n`, 'utf8');
      await fs.promises.rename(tmpPath, filePath);
    } catch (writeError) {
      // Clean up any partial temp file left behind by a failed write.
      try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
      throw writeError;
    }
    log.info(`Wrote local theme to ${filePath}`);
    return { success: true, path: filePath, finalId: slot.finalId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to write local theme: ${message}`);
    return { success: false, error: message };
  }
}

export async function openLocalThemesDir(): Promise<LocalThemeOpenDirResult> {
  try {
    const dir = getLocalThemesDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const result = await shell.openPath(dir);
    if (result) {
      return { success: false, error: result };
    }
    return { success: true, path: dir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to open local themes dir: ${message}`);
    return { success: false, error: message };
  }
}
