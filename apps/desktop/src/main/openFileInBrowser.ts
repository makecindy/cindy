/** Safely open a local HTML file in the system browser. */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  BrowserFileOpenErrorCode,
  BrowserFileOpenResult,
} from '../shared/openFileInBrowser';

const INVALID_BROWSER_FILE_TARGET_ERROR = '路径必须是绝对路径或本地 file:// URL';
const OPEN_BROWSER_FILE_ERROR = '无法在系统浏览器中打开该本地页面';

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
  if (parsed.port) return null;

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
  /** Windows-only fallback that hands the complete file URL to the OS handler. */
  openUrlWithWindowsHandler?(url: string): Promise<void>;
  onOpenExternalError?(details: { filePath: string; hasUrlState: boolean; error: unknown }): void;
  onWindowsUrlFallbackError?(details: { filePath: string; error: unknown }): void;
}

export async function handleOpenFileInBrowser(
  value: string,
  deps: OpenFileInBrowserDeps,
): Promise<BrowserFileOpenResult> {
  try {
    const target = resolveBrowserFileTarget(value);
    if (!target) {
      return {
        success: false,
        error: INVALID_BROWSER_FILE_TARGET_ERROR,
        errorCode: 'BROWSER_FILE_INVALID_TARGET',
      };
    }
    if (!deps.isPathAllowed(target.filePath)) {
      return {
        success: false,
        error: '不允许访问该路径',
        errorCode: 'BROWSER_FILE_PATH_NOT_ALLOWED',
      };
    }
    if (!deps.isBrowserOpenablePath(target.filePath)) {
      return {
        success: false,
        error: '该文件类型不支持浏览器查看',
        errorCode: 'BROWSER_FILE_UNSUPPORTED_TYPE',
      };
    }
    if (!deps.existsSync(target.filePath)) {
      return {
        success: false,
        error: '文件不存在',
        errorCode: 'BROWSER_FILE_NOT_FOUND',
      };
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
      // openPath only accepts a native path. On Windows, hand the complete URL
      // to the OS URL handler first so query/hash state survives the fallback.
      if (target.hasUrlState) {
        if (deps.openUrlWithWindowsHandler) {
          try {
            await deps.openUrlWithWindowsHandler(target.fileUrl);
            return { success: true };
          } catch (fallbackError) {
            deps.onWindowsUrlFallbackError?.({
              filePath: target.filePath,
              error: fallbackError,
            });
          }
        }
        return {
          success: false,
          error: OPEN_BROWSER_FILE_ERROR,
          errorCode: 'BROWSER_FILE_OPEN_FAILED',
        };
      }
      const errorMessage = await deps.openPath(target.filePath);
      return errorMessage
        ? {
            success: false,
            error: errorMessage,
            errorCode: 'BROWSER_FILE_OPEN_FAILED',
          }
        : { success: true };
    }
  } catch (error) {
    return {
      success: false,
      error: OPEN_BROWSER_FILE_ERROR,
      errorCode: 'BROWSER_FILE_OPEN_FAILED',
    };
  }
}
