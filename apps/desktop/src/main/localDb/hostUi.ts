/**
 * Host-owned UI and maintenance facts for the database entry.
 *
 * `localDb/index.ts` needs to tell the user about fatal database states and to
 * run the Electron slimming worker. Both are host concerns: this module lets the
 * Desktop install its implementations while a headless host reports the same
 * failures through logs without importing Electron.
 */

import type { EnsureReadyErrorCode } from './fatalDialogPolicy';

export interface LocalDbSlimmingResult {
  handled: boolean;
  originalDatabaseReady: boolean;
}

export interface LocalDbHostUi {
  /** Packaged release vs development checkout. */
  isPackaged(): boolean;
  /** Surface a fatal startup condition (Desktop: modal dialog). */
  reportFatal(title: string, detail: string, code: EnsureReadyErrorCode): void;
  /** Push a one-shot notice to connected renderers (headless: no-op). */
  broadcast(channel: string, payload: unknown): void;
  /** Terminate the process after an unrecoverable state (Desktop: app.exit). */
  exitApp(code: number): void;
  /** Dev-only schema-drift prompt; headless returns the cancel/default choice. */
  showMessageBoxSync(options: { buttons: string[]; defaultId?: number; cancelId?: number }): number;
  /** Informational notice (Desktop: dialog); headless only logs. */
  showInfo(title: string, message: string): void;
  /** Desktop runs the utility-process slimming worker; the host has none. */
  runStartupSlimming?: (args: {
    dbFilePath: string;
    ownerId: string;
    leaseKind: 'reader' | 'writer';
    userDataDir: string;
  }) => Promise<{ handled: boolean; originalDatabaseReady: boolean }>;
}

const headlessUi: LocalDbHostUi = {
  isPackaged: () => false,
  reportFatal: (title, detail, code) => {
    console.error(`[localDb] ${code}: ${title} — ${detail}`);
  },
  broadcast: () => {},
  showMessageBoxSync: (options) => options.cancelId ?? options.defaultId ?? 0,
  showInfo: (title, message) => {
    console.error(`[localDb] ${title} — ${message}`);
  },
  exitApp: (code) => {
    process.exitCode = code;
  },
};

let ui: LocalDbHostUi = headlessUi;

export function configureLocalDbHostUi(next: LocalDbHostUi): void {
  ui = next;
}

export function localDbHostUi(): LocalDbHostUi {
  return ui;
}
