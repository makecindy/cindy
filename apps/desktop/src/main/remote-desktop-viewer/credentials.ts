import type { RemoteCredentialRequest } from '@cindy/device-link';
import type { RemoteViewerCredentialState } from '../../shared/remoteDesktopViewer';
import { RemoteCredentialHost, remoteCredentialHost } from '../remote-desktop/credentialHost';
import { getResolvedMainLocale } from '../i18n';
import { nativeTheme } from 'electron';

const unavailable: RemoteViewerCredentialState = {
  available: false,
  autoUnlock: false,
  biometricAvailable: false,
  biometricVerification: false,
};

/** Password entry, encryption and storage stay in the signed native helper. */
export class ViewerCredentials {
  private native = new RemoteCredentialHost();
  private pending = false;
  private revision = 0;
  constructor(
    private readonly deps: {
      request<T>(
        message:
          | RemoteCredentialRequest
          | { op: 'credential'; version: 1; kind: 'status' | 'prepare'; setup?: boolean },
        check: () => void,
      ): Promise<T>;
    },
  ) {}
  dispose(): void {
    this.revision++;
    this.pending = false;
    this.native.dispose();
  }
  async run(
    target: string,
    hostPlatform: string | undefined,
    action: unknown,
    enabled: unknown,
    check: () => void,
  ): Promise<RemoteViewerCredentialState> {
    check();
    if (process.platform !== 'darwin' || hostPlatform !== 'darwin') return { ...unavailable };
    if (
      !['settings', 'enable', 'disable', 'unlock', 'biometric'].includes(String(action)) ||
      (action === 'biometric' && typeof enabled !== 'boolean')
    )
      throw new Error('CREDENTIAL_INVALID_MESSAGE');
    if (this.pending) throw new Error('CREDENTIAL_AUTHENTICATION_BUSY');
    this.pending = true;
    const revision = this.revision;
    const current = () => {
      check();
      if (revision !== this.revision) throw new Error('CREDENTIAL_CANCELLED');
    };
    const credentials = remoteCredentialHost.currentToken?.();
    if (!credentials) {
      this.pending = false;
      throw new Error('CREDENTIAL_INVALID_IDENTITY');
    }
    const args = { ...credentials, target };
    const call = async <T>(method: string, values: Record<string, unknown> = {}): Promise<T> => {
      current();
      const result = await this.native.viewerCall(credentials.realm, method, values);
      current();
      return result as T;
    };
    let local: { handle: string; offer: string; descriptor: string } | undefined;
    let host: { handle: string; offer: string } | undefined;
    try {
      let biometricPreferred = true;
      const settings = async (): Promise<RemoteViewerCredentialState> => {
        const value = await call<Record<string, boolean>>('viewerSettings', args);
        biometricPreferred = value.biometricPreferred !== false;
        return {
          available: true,
          autoUnlock: value.autoUnlock === true,
          biometricAvailable: value.biometricAvailable === true,
          biometricVerification: value.biometricVerification === true,
        };
      };
      if (action === 'disable') {
        await call('viewerForget', args);
        return settings();
      }
      if (action === 'biometric') {
        await call('viewerBiometric', { ...args, enabled, locale: getResolvedMainLocale() });
        return settings();
      }
      const state = await settings();
      if (action === 'settings' || (action === 'unlock' && !state.autoUnlock)) return state;
      if (action === 'unlock') {
        const status = await this.deps.request<{ version: number; state: string }>(
          { op: 'credential', version: 1, kind: 'status' },
          current,
        );
        current();
        if (status.version !== 1 || status.state !== 'locked') return state;
      }
      const [configured, preparation] = await Promise.allSettled([
        call('viewerConfigure', args),
        this.deps.request<{ version: number; ready: boolean; descriptor: string }>(
          { op: 'credential', version: 1, kind: 'prepare', setup: action === 'enable' },
          current,
        ),
      ]);
      current();
      if (configured.status === 'rejected') throw configured.reason;
      if (preparation.status === 'rejected') throw preparation.reason;
      const prepared = preparation.value;
      if (prepared.version !== 1 || !prepared.ready || typeof prepared.descriptor !== 'string')
        throw new Error('CREDENTIAL_UNAVAILABLE');
      local = await call<{ handle: string; offer: string; descriptor: string }>('viewerBegin', {
        target,
        descriptor: prepared.descriptor,
        setup: action === 'enable',
        biometric: biometricPreferred && state.biometricAvailable,
      });
      host = await this.deps.request<{ handle: string; offer: string }>(
        {
          op: 'credential',
          version: 1,
          kind: 'open',
          offer: local.offer,
          descriptor: local.descriptor,
        },
        current,
      );
      current();
      const exchange = async (ciphertext: string) => {
        const reply = await this.deps.request<{ ciphertext: string }>(
          { op: 'credential', version: 1, kind: 'exchange', handle: host!.handle, ciphertext },
          current,
        );
        current();
        const json = await call<string>('viewerReceive', {
          handle: local!.handle,
          ciphertext: reply.ciphertext,
        });
        return JSON.parse(json) as { kind: string; saved?: boolean; accepted?: boolean };
      };
      const ready = await exchange(
        await call<string>('viewerAccept', { handle: local.handle, offer: host.offer }),
      );
      if (ready.kind !== 'ready') throw new Error('CREDENTIAL_INVALID_MESSAGE');
      const ciphertext = await call<string>('viewerPassword', {
        handle: local.handle,
        saved: action !== 'enable' && ready.saved === true,
        locale: getResolvedMainLocale(),
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
      let result;
      try {
        result = await exchange(ciphertext);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'INVOKE_TIMEOUT') throw error;
        // Never replay a password after an uncertain response.
        result = await exchange(
          await call<string>('viewerAuthenticationStatus', { handle: local.handle }),
        );
      }
      if (result.kind !== 'authenticated' || !result.accepted)
        throw new Error('CREDENTIAL_PASSWORD_REJECTED');
      return await settings();
    } finally {
      if (local && revision === this.revision) {
        try {
          const ciphertext = await call<string>('viewerEnd', { handle: local.handle });
          if (ciphertext && host)
            await this.deps.request(
              { op: 'credential', version: 1, kind: 'exchange', handle: host.handle, ciphertext },
              current,
            );
        } catch {
          /* Lease and ordinary viewing do not depend on optional authentication. */
        }
      }
      if (revision === this.revision) this.pending = false;
    }
  }
}
