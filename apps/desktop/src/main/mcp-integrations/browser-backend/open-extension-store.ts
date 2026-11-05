import { execFile, spawn } from 'node:child_process';

import {
  RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL,
  type BrowserExtensionStoreOpenResult,
} from '../../../shared/browserBackend.js';
import type { InstalledChromium } from '../browser-real-profile/types.js';

export interface OpenExtensionStoreDeps {
  platform?: NodeJS.Platform;
  /** The user's default Chromium browser, else the first installed one; throws when none. */
  resolveBrowser: () => InstalledChromium;
  launch?: (file: string, args: string[]) => Promise<void>;
}

function defaultLaunch(file: string, args: string[]): Promise<void> {
  if (file === '/usr/bin/open') {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Open the official Cindy extension's store page in the browser the user actually uses, so
 * "My browser" can be finished from Settings. The store still asks the user to confirm Add;
 * Settings notices the connection on its own once the extension is in.
 */
export async function openExtensionStoreInUserBrowser(
  deps: OpenExtensionStoreDeps,
): Promise<BrowserExtensionStoreOpenResult> {
  let browser: InstalledChromium;
  try {
    browser = deps.resolveBrowser();
  } catch {
    return { ok: false, error: 'NO_CHROMIUM' };
  }
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? defaultLaunch;
  const url = RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL;
  // On macOS hand the URL to the app bundle so an already running browser opens it as a tab.
  const appBundle = platform === 'darwin' ? /^(.*?\.app)\//.exec(browser.executablePath)?.[1] : undefined;
  try {
    if (appBundle) await launch('/usr/bin/open', ['-a', appBundle, url]);
    else await launch(browser.executablePath, [url]);
    return { ok: true };
  } catch {
    return { ok: false, error: 'OPEN_FAILED' };
  }
}
