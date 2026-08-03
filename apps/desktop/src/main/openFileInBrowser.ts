/** Safely open a local HTML file in the system browser. */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface BrowserFileTarget {
  filePath: string;
  fileUrl: string;
  hasUrlState: boolean;
}

/**
 * Accept the legacy absolute-path input and the full local file URL used by the
 * built-in browser. Non-local authorities are rejected instead of being
 * silently mapped onto a different local path.
 */
export function resolveBrowserFileTarget(value: string): BrowserFileTarget | null {
  if (!value) return null;
  if (path.isAbsolute(value)) {
    return {
      filePath: value,
      fileUrl: pathToFileURL(value).toString(),
      hasUrlState: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname && parsed.hostname !== 'localhost') return null;

  let filePath: string;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return null;
  }
  if (!path.isAbsolute(filePath)) return null;

  return {
    filePath,
    fileUrl: parsed.toString(),
    hasUrlState: Boolean(parsed.search || parsed.hash),
  };
}

export interface OpenFileInBrowserDeps {
  isPathAllowed(filePath: string): boolean;
  isBrowserOpenablePath(filePath: string): boolean;
  existsSync(filePath: string): boolean;
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
  onOpenExternalError?(details: { filePath: string; hasUrlState: boolean; error: unknown }): void;
}

export async function handleOpenFileInBrowser(
  value: string,
  deps: OpenFileInBrowserDeps,
): Promise<{ success: boolean; error?: string }> {
  try {
    const target = resolveBrowserFileTarget(value);
    if (!target) {
      return { success: false, error: 'Path must be absolute or a local file URL' };
    }
    if (!deps.isPathAllowed(target.filePath)) {
      return { success: false, error: '不允许访问该路径' };
    }
    if (!deps.isBrowserOpenablePath(target.filePath)) {
      return { success: false, error: '该文件类型不支持浏览器查看' };
    }
    if (!deps.existsSync(target.filePath)) {
      return { success: false, error: '文件不存在' };
    }

    try {
      await deps.openExternal(target.fileUrl);
      return { success: true };
    } catch (error) {
      deps.onOpenExternalError?.({
        filePath: target.filePath,
        hasUrlState: target.hasUrlState,
        error,
      });
      // openPath only accepts a native path. Falling back when the original URL
      // has query/hash would silently open the wrong SPA route or page state.
      if (target.hasUrlState) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      const errorMessage = await deps.openPath(target.filePath);
      return errorMessage ? { success: false, error: errorMessage } : { success: true };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
