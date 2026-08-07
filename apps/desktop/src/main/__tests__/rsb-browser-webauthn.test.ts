import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePopupMocks = vi.hoisted(() => ({
  getOwner: vi.fn(() => null),
}));

vi.mock('../rsb-browser-bridge/native-popup-surfaces.js', () => ({
  getRsbNativePopupOwnerWebContents: nativePopupMocks.getOwner,
}));

import { BrowserWindow, webContents } from 'electron';

import { BROWSER_PARTITION } from '../../shared/webviewPartition';
import {
  configureRsbBrowserWebAuthn,
  installRsbWebAuthnAccountSelection,
  resolveWebAuthnKeychainAccessGroup,
  selectRsbWebAuthnAccount,
} from '../rsb-browser-webauthn';
import { RSB_BROWSER_WEBAUTHN_LABELS } from '../rsbBrowserWebAuthnLabels';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const visibleOwner = {
  isDestroyed: () => false,
  isVisible: () => true,
};
const resolveVisibleOwner = () => visibleOwner;

afterEach(() => {
  vi.restoreAllMocks();
  nativePopupMocks.getOwner.mockReset();
  nativePopupMocks.getOwner.mockReturnValue(null);
});

function createSessionHarness() {
  let listener:
    | ((
        event: unknown,
        details: {
          relyingPartyId: string;
          accounts: Array<{
            credentialId: string;
            displayName?: string;
            name?: string;
          }>;
          frame: { detached: boolean } | null;
        },
        callback: (credentialId?: string | null) => void,
      ) => void)
    | undefined;
  const browserSession = {
    on: vi.fn((event: string, nextListener: typeof listener) => {
      expect(event).toBe('select-webauthn-account');
      listener = nextListener;
    }),
  };
  return {
    browserSession,
    getListener: () => {
      if (!listener) throw new Error('listener not installed');
      return listener;
    },
  };
}

describe('resolveWebAuthnKeychainAccessGroup', () => {
  it('combines the signed Apple team identity with the runtime bundle id', () => {
    expect(resolveWebAuthnKeychainAccessGroup('TEAM123456', 'com.xd.cindy')).toBe(
      'TEAM123456.com.xd.cindy.webauthn',
    );
  });

  it.each([
    [undefined, 'com.xd.cindy'],
    ['', 'com.xd.cindy'],
    ['too-short', 'com.xd.cindy'],
    ['TEAM123456', ''],
    ['TEAM123456', 'com..xd.cindy'],
    ['TEAM123456', 'com.xd.cindy<bad>'],
  ])('fails closed for an invalid signing identity (%s, %s)', (teamId, appId) => {
    expect(resolveWebAuthnKeychainAccessGroup(teamId, appId)).toBeNull();
  });
});

describe('selectRsbWebAuthnAccount', () => {
  const labels = RSB_BROWSER_WEBAUTHN_LABELS.en;

  it('returns the only discoverable credential without showing a redundant chooser', async () => {
    const showDialog = vi.fn();
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: [{ credentialId: 'credential-1', name: 'dash@example.com' }],
          frame: { detached: false },
        },
        { labels, showDialog, resolveDialogOwner: resolveVisibleOwner },
      ),
    ).resolves.toBe('credential-1');
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('shows every account and returns the selected credential id', async () => {
    const showDialog = vi.fn(async () => ({ response: 1 }));
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'login.example.com',
          accounts: [
            { credentialId: 'credential-1', displayName: 'Dash', name: 'dash@example.com' },
            { credentialId: 'credential-2', name: 'work@example.com' },
          ],
          frame: { detached: false },
        },
        { labels, showDialog, resolveDialogOwner: resolveVisibleOwner },
      ),
    ).resolves.toBe('credential-2');

    expect(showDialog).toHaveBeenCalledWith(
      visibleOwner,
      expect.objectContaining({
        title: 'Choose a Passkey',
        message: 'Choose a passkey for login.example.com',
        buttons: ['1. Dash (dash@example.com)', '2. work@example.com', 'Cancel Passkey Sign-In'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }),
    );
  });

  it('cancels when the frame is stale, the user cancels, or navigation wins the dialog race', async () => {
    const detachedFrame = { detached: true };
    const neverShown = vi.fn();
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: detachedFrame,
        },
        { labels, showDialog: neverShown, resolveDialogOwner: resolveVisibleOwner },
      ),
    ).resolves.toBeUndefined();
    expect(neverShown).not.toHaveBeenCalled();

    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: { detached: false },
        },
        {
          labels,
          showDialog: async () => ({ response: 2 }),
          resolveDialogOwner: resolveVisibleOwner,
        },
      ),
    ).resolves.toBeUndefined();

    const frame = { detached: false };
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame,
        },
        {
          labels,
          showDialog: async () => {
            frame.detached = true;
            return { response: 0 };
          },
          resolveDialogOwner: resolveVisibleOwner,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('normalizes authenticator-provided labels before placing them on native buttons', async () => {
    const showDialog = vi.fn(async () => ({ response: 2 }));
    await selectRsbWebAuthnAccount(
      {
        relyingPartyId: 'example.com\nspoofed prompt',
        accounts: [
          { credentialId: 'credential-1', displayName: 'Dash\n\u202eAdmin' },
          { credentialId: 'credential-2' },
        ],
        frame: { detached: false },
      },
      { labels, showDialog, resolveDialogOwner: resolveVisibleOwner },
    );

    expect(showDialog).toHaveBeenCalledWith(
      visibleOwner,
      expect.objectContaining({
        message: 'Choose a passkey for example.com spoofed prompt',
        buttons: ['1. Dash Admin', '2. Passkey 2', 'Cancel Passkey Sign-In'],
      }),
    );
  });

  it('fails closed when the request source is not the visible focused RSB surface', async () => {
    const showDialog = vi.fn();
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'background.example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: { detached: false },
        },
        { labels, showDialog, resolveDialogOwner: () => null },
      ),
    ).resolves.toBeUndefined();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('resolves the BrowserWindow through an ordinary RSB webview host', async () => {
    const source = {
      id: 101,
      hostWebContents: { id: 11 },
      isDestroyed: () => false,
      isFocused: () => true,
    };
    const fromFrame = vi.spyOn(webContents, 'fromFrame').mockReturnValue(source as never);
    const fromWebContents = vi
      .spyOn(BrowserWindow, 'fromWebContents')
      .mockImplementation((candidate) =>
        candidate === source.hostWebContents ? (visibleOwner as never) : null,
      );
    const showDialog = vi.fn(async () => ({ response: 0 }));

    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: { detached: false },
        },
        { labels, showDialog },
      ),
    ).resolves.toBe('credential-1');

    expect(fromFrame).toHaveBeenCalledOnce();
    expect(fromWebContents).toHaveBeenCalledWith(source.hostWebContents);
    expect(showDialog).toHaveBeenCalledWith(visibleOwner, expect.anything());
  });

  it('resolves an adopted native popup through the existing popup owner registry', async () => {
    const source = {
      id: 202,
      isDestroyed: () => false,
      isFocused: () => true,
    };
    const hostWebContents = { id: 22 };
    nativePopupMocks.getOwner.mockReturnValue(hostWebContents as never);
    const fromFrame = vi.spyOn(webContents, 'fromFrame').mockReturnValue(source as never);
    const fromWebContents = vi
      .spyOn(BrowserWindow, 'fromWebContents')
      .mockImplementation((candidate) =>
        candidate === hostWebContents ? (visibleOwner as never) : null,
      );
    const showDialog = vi.fn(async () => ({ response: 1 }));

    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'popup.example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: { detached: false },
        },
        { labels, showDialog },
      ),
    ).resolves.toBe('credential-2');

    expect(fromFrame).toHaveBeenCalledOnce();
    expect(nativePopupMocks.getOwner).toHaveBeenCalledWith(source.id);
    expect(fromWebContents).toHaveBeenCalledWith(hostWebContents);
    expect(showDialog).toHaveBeenCalledWith(visibleOwner, expect.anything());
  });

  it('fails closed when a native popup has no live owner', async () => {
    const source = {
      id: 303,
      isDestroyed: () => false,
      isFocused: () => true,
    };
    vi.spyOn(webContents, 'fromFrame').mockReturnValue(source as never);
    const showDialog = vi.fn();

    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'orphan.example.com',
          accounts: [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }],
          frame: { detached: false },
        },
        { labels, showDialog },
      ),
    ).resolves.toBeUndefined();
    expect(nativePopupMocks.getOwner).toHaveBeenCalledWith(source.id);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it('rejects an authenticator response too large for a safe native chooser', async () => {
    const showDialog = vi.fn();
    await expect(
      selectRsbWebAuthnAccount(
        {
          relyingPartyId: 'example.com',
          accounts: Array.from({ length: 21 }, (_, index) => ({
            credentialId: `credential-${index}`,
          })),
          frame: { detached: false },
        },
        { labels, showDialog, resolveDialogOwner: resolveVisibleOwner },
      ),
    ).resolves.toBeUndefined();
    expect(showDialog).not.toHaveBeenCalled();
  });
});

describe('installRsbWebAuthnAccountSelection', () => {
  it('installs once per session and invokes Electron callback exactly once on failure', async () => {
    const harness = createSessionHarness();
    const selectAccount = vi.fn(async () => {
      throw new Error('chooser unavailable');
    });

    expect(
      installRsbWebAuthnAccountSelection(harness.browserSession, {
        selectAccount,
        logger: silentLogger,
      }),
    ).toBe(true);
    expect(
      installRsbWebAuthnAccountSelection(harness.browserSession, {
        selectAccount,
        logger: silentLogger,
      }),
    ).toBe(false);
    expect(harness.browserSession.on).toHaveBeenCalledOnce();

    const callback = vi.fn();
    harness.getListener()(
      {},
      {
        relyingPartyId: 'example.com',
        accounts: [{ credentialId: 'credential-1' }],
        frame: { detached: false },
      },
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it('serializes concurrent chooser requests', async () => {
    const harness = createSessionHarness();
    let finishFirst: (() => void) | undefined;
    const selectAccount = vi
      .fn<() => Promise<string | undefined>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve('credential-1');
          }),
      )
      .mockResolvedValueOnce('credential-2');
    installRsbWebAuthnAccountSelection(harness.browserSession, { selectAccount });

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const details = {
      relyingPartyId: 'example.com',
      accounts: [{ credentialId: 'credential-1' }],
      frame: { detached: false },
    };
    harness.getListener()({}, details, firstCallback);
    harness.getListener()({}, details, secondCallback);

    await vi.waitFor(() => expect(selectAccount).toHaveBeenCalledTimes(1));
    expect(secondCallback).not.toHaveBeenCalled();
    finishFirst?.();
    await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledWith('credential-2'));
    expect(firstCallback).toHaveBeenCalledWith('credential-1');
  });
});

describe('configureRsbBrowserWebAuthn', () => {
  it('installs account selection on Windows without applying macOS configuration', () => {
    const harness = createSessionHarness();
    const configureWebAuthn = vi.fn();
    expect(
      configureRsbBrowserWebAuthn({
        platform: 'win32',
        browserSession: harness.browserSession,
        configureWebAuthn,
        logger: silentLogger,
      }),
    ).toEqual({ accountSelectionInstalled: true, touchIdConfigured: false });
    expect(configureWebAuthn).not.toHaveBeenCalled();
  });

  it('fails closed on unsigned macOS builds but keeps roaming authenticator selection', () => {
    const harness = createSessionHarness();
    const configureWebAuthn = vi.fn();
    expect(
      configureRsbBrowserWebAuthn({
        platform: 'darwin',
        appleTeamId: '',
        appId: 'com.xd.cindy',
        browserSession: harness.browserSession,
        configureWebAuthn,
        logger: silentLogger,
      }),
    ).toEqual({ accountSelectionInstalled: true, touchIdConfigured: false });
    expect(configureWebAuthn).not.toHaveBeenCalled();
  });

  it('configures signed macOS builds with the matching keychain group and localized reason', () => {
    const harness = createSessionHarness();
    const configureWebAuthn = vi.fn();
    expect(
      configureRsbBrowserWebAuthn({
        platform: 'darwin',
        appleTeamId: 'TEAM123456',
        appId: 'com.xd.cindy',
        browserSession: harness.browserSession,
        configureWebAuthn,
        logger: silentLogger,
      }),
    ).toEqual({ accountSelectionInstalled: true, touchIdConfigured: true });
    expect(configureWebAuthn).toHaveBeenCalledWith({
      touchID: {
        keychainAccessGroup: 'TEAM123456.com.xd.cindy.webauthn',
        promptReason: expect.stringContaining('$1'),
      },
    });
    expect(harness.browserSession.on).toHaveBeenCalledWith(
      'select-webauthn-account',
      expect.any(Function),
    );
    expect(BROWSER_PARTITION).toBe('persist:xdmaker-browser-app');
  });
});
