/**
 * RSB browser WebAuthn host integration.
 *
 * WebAuthn itself stays inside Chromium and the OS authenticator. Main only
 * enables Electron's macOS Touch ID backend for correctly signed builds and
 * supplies the account chooser Electron requires when an authenticator returns
 * multiple discoverable credentials. Ordinary RSB webviews and adopted popup
 * WebContents share BROWSER_PARTITION, so this single session listener covers
 * both without weakening renderer or webview isolation.
 */
import {
  app,
  BrowserWindow,
  dialog,
  session,
  webContents,
  type ConfigureWebAuthnOptions,
  type MessageBoxOptions,
  type WebAuthnAccount,
  type WebContents,
  type WebFrameMain,
} from 'electron';

import { CURRENT_APP_ID } from '../shared/brandRegion.js';
import { BROWSER_PARTITION } from '../shared/webviewPartition.js';
import { getResolvedMainLocale } from './i18n.js';
import { createLogger, type Logger } from './logger.js';
import {
  RSB_BROWSER_WEBAUTHN_LABELS,
  type RsbBrowserWebAuthnLabels,
} from './rsbBrowserWebAuthnLabels.js';
import { getRsbNativePopupOwnerWebContents } from './rsb-browser-bridge/native-popup-surfaces.js';

const log = createLogger('rsb-webauthn');
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const APP_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MAX_ACCOUNT_LABEL_LENGTH = 96;
const MAX_RELYING_PARTY_ID_LENGTH = 253;
const MAX_CHOOSER_ACCOUNTS = 20;

type WebAuthnSelectionDetails = {
  relyingPartyId: string;
  accounts: WebAuthnAccount[];
  frame: Pick<WebFrameMain, 'detached'> | null;
};

type WebAuthnSelectionCallback = (credentialId?: string | null) => void;
type WebAuthnSelectionListener = (
  event: unknown,
  details: WebAuthnSelectionDetails,
  callback: WebAuthnSelectionCallback,
) => void;

interface WebAuthnSessionLike {
  on(event: 'select-webauthn-account', listener: WebAuthnSelectionListener): unknown;
}

interface AccountDialogResult {
  response: number;
}

type AccountDialogOwner = Pick<BrowserWindow, 'isDestroyed' | 'isVisible'>;
type NativePopupOwnerResolver = (webContentsId: number) => WebContents | null;
type ShowAccountDialog = (
  owner: AccountDialogOwner,
  options: MessageBoxOptions,
) => Promise<AccountDialogResult>;
type ResolveAccountDialogOwner = (
  frame: WebAuthnSelectionDetails['frame'],
) => AccountDialogOwner | null;
type SelectAccount = (details: WebAuthnSelectionDetails) => Promise<string | undefined>;

export interface ConfigureRsbBrowserWebAuthnDependencies {
  platform?: NodeJS.Platform;
  appleTeamId?: string;
  appId?: string;
  browserSession?: WebAuthnSessionLike;
  configureWebAuthn?: (options: ConfigureWebAuthnOptions) => void;
  selectAccount?: SelectAccount;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

const configuredSessions = new WeakSet<object>();

/** Build the access group shared by Electron runtime configuration and signing. */
export function resolveWebAuthnKeychainAccessGroup(
  appleTeamId: string | undefined,
  appId: string,
): string | null {
  const teamId = appleTeamId?.trim() ?? '';
  const bundleId = appId.trim();
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) return null;
  if (!APP_ID_PATTERN.test(bundleId) || bundleId.includes('..')) return null;
  return `${teamId}.${bundleId}.webauthn`;
}

function frameIsDetached(frame: WebAuthnSelectionDetails['frame']): boolean {
  if (!frame) return true;
  try {
    return frame.detached;
  } catch {
    return true;
  }
}

function boundedSingleLine(value: string | undefined, maxLength: number): string {
  return (
    (value ?? '')
      .replace(/\p{Cc}+/gu, ' ')
      // Authenticator account names are untrusted. Strip Unicode formatting and
      // bidi controls so a credential cannot visually reorder the native dialog.
      .replace(/\p{Cf}+/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength)
  );
}

function accountButtonLabel(
  account: WebAuthnAccount,
  index: number,
  labels: RsbBrowserWebAuthnLabels,
): string {
  const displayName = boundedSingleLine(account.displayName, MAX_ACCOUNT_LABEL_LENGTH);
  const name = boundedSingleLine(account.name, MAX_ACCOUNT_LABEL_LENGTH);
  const accountLabel =
    displayName && name && displayName !== name
      ? `${displayName} (${name})`.slice(0, MAX_ACCOUNT_LABEL_LENGTH)
      : displayName || name || labels.unknownAccount.replace('{{index}}', String(index + 1));
  // A stable ordinal prevents an authenticator-controlled label from being
  // confused with the cancel action or another credential.
  return `${index + 1}. ${accountLabel}`;
}

function relyingPartyLabel(value: string): string {
  return boundedSingleLine(value, MAX_RELYING_PARTY_ID_LENGTH);
}

function defaultResolveAccountDialogOwner(
  frame: WebAuthnSelectionDetails['frame'],
  resolveNativePopupOwner: NativePopupOwnerResolver = getRsbNativePopupOwnerWebContents,
): AccountDialogOwner | null {
  if (!frame || frameIsDetached(frame)) return null;
  try {
    const source = webContents.fromFrame(frame as WebFrameMain);
    if (!source || source.isDestroyed() || !source.isFocused()) return null;
    const nativePopupOwner = resolveNativePopupOwner(source.id);
    const owner =
      BrowserWindow.fromWebContents(source) ??
      (source.hostWebContents ? BrowserWindow.fromWebContents(source.hostWebContents) : null) ??
      (nativePopupOwner ? BrowserWindow.fromWebContents(nativePopupOwner) : null);
    if (!owner || owner.isDestroyed() || !owner.isVisible()) return null;
    return owner;
  } catch {
    return null;
  }
}

function defaultShowAccountDialog(
  owner: AccountDialogOwner,
  options: MessageBoxOptions,
): Promise<AccountDialogResult> {
  return dialog.showMessageBox(owner as BrowserWindow, options);
}

/**
 * Ask the user which discoverable credential to use. A stale/detached request
 * is cancelled rather than allowing a selection to cross a navigation boundary.
 */
export async function selectRsbWebAuthnAccount(
  details: WebAuthnSelectionDetails,
  options: {
    labels?: RsbBrowserWebAuthnLabels;
    showDialog?: ShowAccountDialog;
    resolveDialogOwner?: ResolveAccountDialogOwner;
    resolveNativePopupOwner?: NativePopupOwnerResolver;
  } = {},
): Promise<string | undefined> {
  if (
    frameIsDetached(details.frame) ||
    details.accounts.length === 0 ||
    details.accounts.length > MAX_CHOOSER_ACCOUNTS
  )
    return undefined;
  const owner = (
    options.resolveDialogOwner ??
    ((frame) => defaultResolveAccountDialogOwner(frame, options.resolveNativePopupOwner))
  )(details.frame);
  if (!owner) return undefined;
  if (details.accounts.length === 1) return details.accounts[0]?.credentialId || undefined;

  const labels = options.labels ?? RSB_BROWSER_WEBAUTHN_LABELS[getResolvedMainLocale()];
  const buttons = details.accounts.map((account, index) =>
    accountButtonLabel(account, index, labels),
  );
  const cancelId = buttons.length;
  buttons.push(labels.cancel);

  const result = await (options.showDialog ?? defaultShowAccountDialog)(owner, {
    type: 'question',
    title: labels.title,
    message: labels.message.replace(
      '{{relyingPartyId}}',
      relyingPartyLabel(details.relyingPartyId) || labels.unknownRelyingParty,
    ),
    detail: labels.detail,
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  });

  if (frameIsDetached(details.frame)) return undefined;
  if (!Number.isInteger(result.response) || result.response < 0 || result.response >= cancelId) {
    return undefined;
  }
  return details.accounts[result.response]?.credentialId;
}

/** Install Electron's mandatory discoverable-account callback once per session. */
export function installRsbWebAuthnAccountSelection(
  browserSession: WebAuthnSessionLike,
  options: {
    selectAccount?: SelectAccount;
    logger?: Pick<Logger, 'warn'>;
  } = {},
): boolean {
  if (configuredSessions.has(browserSession as object)) return false;
  const selectAccount = options.selectAccount ?? ((details) => selectRsbWebAuthnAccount(details));
  const logger = options.logger ?? log;
  let selectionQueue = Promise.resolve();
  browserSession.on('select-webauthn-account', (_event, details, callback) => {
    const runSelection = async () => {
      let credentialId: string | undefined;
      try {
        credentialId = await selectAccount(details);
      } catch (error) {
        logger.warn('account selection failed; cancelling WebAuthn request', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        callback(credentialId);
      }
    };
    // Native message boxes are modal but concurrent WebAuthn requests can still
    // arrive from separate RSB guests. Serialize them, then re-check source focus
    // inside selectRsbWebAuthnAccount before presenting each chooser.
    selectionQueue = selectionQueue.then(runSelection, runSelection);
  });
  configuredSessions.add(browserSession as object);
  return true;
}

/** Configure WebAuthn for the persistent RSB browser session after app ready. */
export function configureRsbBrowserWebAuthn(
  dependencies: ConfigureRsbBrowserWebAuthnDependencies = {},
): { accountSelectionInstalled: boolean; touchIdConfigured: boolean } {
  const logger = dependencies.logger ?? log;
  const browserSession =
    dependencies.browserSession ??
    (session.fromPartition(BROWSER_PARTITION) as unknown as WebAuthnSessionLike);
  const accountSelectionInstalled = installRsbWebAuthnAccountSelection(browserSession, {
    selectAccount: dependencies.selectAccount,
    logger,
  });

  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    logger.info('WebAuthn account selection installed', {
      partition: BROWSER_PARTITION,
      touchId: false,
    });
    return { accountSelectionInstalled, touchIdConfigured: false };
  }

  const keychainAccessGroup = resolveWebAuthnKeychainAccessGroup(
    dependencies.appleTeamId ?? process.env.CINDY_WEBAUTHN_APPLE_TEAM_ID,
    dependencies.appId ?? CURRENT_APP_ID,
  );
  if (!keychainAccessGroup) {
    logger.info('Touch ID WebAuthn unavailable in this build: no signed Apple Team identity', {
      partition: BROWSER_PARTITION,
    });
    return { accountSelectionInstalled, touchIdConfigured: false };
  }

  const labels = RSB_BROWSER_WEBAUTHN_LABELS[getResolvedMainLocale()];
  try {
    (dependencies.configureWebAuthn ?? ((options) => app.configureWebAuthn(options)))({
      touchID: {
        keychainAccessGroup,
        promptReason: labels.touchIdPromptReason,
      },
    });
    logger.info('Touch ID WebAuthn configured', {
      partition: BROWSER_PARTITION,
    });
    return { accountSelectionInstalled, touchIdConfigured: true };
  } catch (error) {
    logger.error('failed to configure Touch ID WebAuthn', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { accountSelectionInstalled, touchIdConfigured: false };
  }
}
