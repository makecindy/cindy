import { isValidVerificationUrl } from '@cindy/mcps/feishu-local';
import type {
  FeishuLocalHostPort,
  FeishuLocalReasonCode,
  FeishuLocalSetupInput,
} from '@cindy/mcps/feishu-local';

export interface HostConfirmationPayload {
  ghostId: string;
  ghostName: string;
  body: string;
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
}

export interface HostConfirmations {
  confirm(payload: HostConfirmationPayload): Promise<boolean>;
}

export interface SetupAdapterOptions {
  port: FeishuLocalHostPort;
  confirmations: HostConfirmations;
  current(): boolean;
  ownerScope(): string;
  t(key: string): string;
}

export interface SetupResult {
  ok: boolean;
  reasonCode?: FeishuLocalReasonCode;
  message?: string;
}

function setupUnavailable(): SetupResult {
  return { ok: false, reasonCode: 'SETUP_UNAVAILABLE', message: 'A native setup card is unavailable in this host.' };
}

/**
 * Node Host uses the existing owner-bound confirmation bridge. The URL is shown
 * only in that transient card; tool results and logs keep a stable reason code.
 */
export function createFeishuLocalHostSetupAdapter(options: SetupAdapterOptions) {
  return async (input: FeishuLocalSetupInput): Promise<SetupResult> => {
    let scope: string;
    try {
      if (!options.current()) return setupUnavailable();
      scope = options.ownerScope();
    } catch {
      return setupUnavailable();
    }
    const assertCurrent = () => {
      if (!options.current()) throw new Error('OWNER_SCOPE_CHANGED');
      try {
        if (options.ownerScope() !== scope) throw new Error('OWNER_SCOPE_CHANGED');
      } catch {
        throw new Error('OWNER_SCOPE_CHANGED');
      }
    };
    const confirm = async (body: string): Promise<boolean> => {
      assertCurrent();
      const accepted = await options.confirmations.confirm({
        ghostId: 'feishu-local-cli',
        ghostName: 'Feishu Local CLI',
        body,
        confirmText: options.t('remoteDesktop.connect'),
        cancelText: null,
        danger: false,
      });
      assertCurrent();
      return accepted;
    };
    try {
      const auth = await options.port.readAuth();
      assertCurrent();
      if (auth.reason_code && !['NOT_AUTHORIZED', 'SCOPE_MISSING', 'SETUP_REQUIRED'].includes(auth.reason_code)) {
        return { ok: false, reasonCode: auth.reason_code };
      }
      if (auth.state === 'ready' && !auth.reason_code && input.reauthorize !== true) return { ok: true };
      if (auth.reason_code === 'SETUP_REQUIRED') {
        const accepted = await confirm('Import an existing terminal Feishu CLI login into Cindy for this account? No token is shown in chat.');
        if (!accepted) return setupUnavailable();
        const imported = await options.port.connect({
          mode: 'import-terminal',
          assertCurrent,
          beforeCommit: async () => assertCurrent(),
        });
        if (imported.ok) return { ok: true };
        if (imported.reasonCode && !['NOT_AUTHORIZED', 'SCOPE_MISSING'].includes(imported.reasonCode)) {
          return { ok: false, reasonCode: imported.reasonCode };
        }
      }
    } catch {
      return setupUnavailable();
    }
    let markCardAccepted!: () => void;
    let cardAccepted = false;
    const cardPromise = new Promise<void>(resolve => { markCardAccepted = resolve; });
    const login = options.port.connect({
      mode: 'login',
      onAuthorizationUrl: async (url) => {
        assertCurrent();
        if (!isValidVerificationUrl(url)) throw new Error('INVALID_VERIFICATION_URL');
        const accepted = await confirm(`Open this verified HTTPS link on the computer running the Feishu CLI, approve the request, then return here: ${url}`);
        if (!accepted) throw new Error('USER_CANCELLED');
        cardAccepted = true;
        markCardAccepted();
      },
      assertCurrent,
      beforeCommit: async () => assertCurrent(),
    }).catch(() => ({ ok: false as const, reasonCode: 'SETUP_UNAVAILABLE' as const }));
    await Promise.race([cardPromise, login.then(() => undefined)]);
    if (!cardAccepted) return setupUnavailable();
    return {
      ok: false,
      reasonCode: 'SETUP_REQUIRED',
      message: 'Authorization card sent. Complete it in Cindy; no device code or token is exposed in chat.',
    };
  };
}
