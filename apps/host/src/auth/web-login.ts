import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuthApiError, reduceAuthFlow, ssoOrgDiscoveryToMethods,
  type CindyAuthClient, type AuthFlowState, type AuthRegion, type AuthSuccess,
  type LoginOutcome, type LoginMethod, type ProviderConfig } from '@cindy/auth-client';
import { parseDesktopLoginAction } from '../../../desktop/src/shared/authIpc.js';
import { createDesktopPollCredentials, runHostedCallbackPolling } from '../../../desktop/src/main/authHostedCallback.js';

/** One authenticated controller owns the pending tickets; only presentation state leaves Host. */
export function createHostWebLogin(deps: {
  client: CindyAuthClient; region: AuthRegion; hostedCallbackUrl: string;
  registerDeviceLink?(accessToken: string): Promise<void>;
  complete(outcome: AuthSuccess, signal: AbortSignal, activate: (start: () => Promise<void>) => Promise<void>): Promise<void>;
}) {
  let state: (AuthFlowState & { retryAt?: number }) | null = null;
  let providerConfig: ProviderConfig | null = null;
  let providersFlight: Promise<void> | null = null;
  let controller: string | null = null;
  let methods: LoginMethod[] = [];
  let outcome: LoginOutcome | null = null;
  let cancellation = new AbortController();
  let flight: Promise<void> | null = null;
  let pending: Promise<void> | null = null;
  let finishPending: (() => void) | undefined;
  const result = () => state?.step === 'error'
    ? { success: false as const, code: state.code, state, ...(state.retryAt !== undefined ? { retryAt: state.retryAt } : {}) }
    : { success: true as const, state };
  const fail = (error: unknown) => {
    const code = error instanceof AuthApiError ? error.code : 'AUTH_REQUEST_FAILED';
    state = { ...reduceAuthFlow(state, { type: 'failed', code, recoverTo: 'identifier' }),
      ...(error instanceof AuthApiError && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}) };
    return result();
  };
  async function loadProviders() {
    if (!providersFlight) providersFlight = deps.client.getProviders().then(providers => {
      providerConfig = providers;
      // Declare captcha-backed login unavailable; the existing renderer still shows its identifier input.
      state = reduceAuthFlow(state, { type: 'providers-loaded', providers: { ...providers, email: false, phone: false } });
    }).finally(() => { providersFlight = null; });
    await providersFlight;
  }
  async function accept(next: LoginOutcome, signal: AbortSignal) {
    signal.throwIfAborted();
    outcome = null;
    if (next.status === 'binding_required') throw new AuthApiError('NOT_SUPPORTED', 400, 'Binding is unavailable');
    if (next.status === 'ok') {
      await deps.complete(next, signal, async start => {
        // A second hello could replace the resident connection for this device.
        try { await deps.registerDeviceLink?.(next.accessToken); }
        catch { /* Remote registration failure does not fail account sign-in. */ }
        signal.throwIfAborted();
        await start();
      });
      signal.throwIfAborted();
    }
    if (next.status !== 'ok') outcome = next;
    state = reduceAuthFlow(state, { type: 'outcome', outcome: next });
  }
  async function cancel() {
    cancellation.abort();
    await Promise.all([flight, pending]);
    cancellation = new AbortController();
    outcome = null; methods = []; state = null; controller = null;
  }
  function releaseFinishedController() {
    if (cancellation.signal.aborted || pending || flight || outcome || state?.step === 'method-choice') return;
    methods = [];
    controller = null;
  }
  return {
    async getLoginState() {
      try { if (!state) await loadProviders(); return result(); }
      catch (error) { return fail(error); }
    },
    async dispatchLoginAction(value: unknown, caller: string) {
      if (!caller) throw new Error('Authenticated login controller is required');
      const action = parseDesktopLoginAction(value);
      if (!action) return { success: false, code: 'INVALID_AUTH_ACTION', state };
      if (controller && controller !== caller) return { success: false, code: 'AUTH_BUSY', state: null };
      if (['reset', 'back', 'cancel-browser'].includes(action.type)) {
        await cancel();
        try { await loadProviders(); return result(); } catch (error) { return fail(error); }
      }
      if (pending || flight) return { success: false, code: 'AUTH_BUSY', state };
      controller = caller;
      pending = new Promise(resolve => { finishPending = resolve; });
      const signal = cancellation.signal;
      try {
        if (!state) await loadProviders();
        signal.throwIfAborted();
        if (action.type === 'discover-sso-org') {
          const discovery = await deps.client.discoverSsoOrg(action.org);
          signal.throwIfAborted();
          if (discovery.region !== deps.region) throw new AuthApiError('ORG_REALM_UNAVAILABLE', 400, 'SSO region differs from Host');
          methods = ssoOrgDiscoveryToMethods(discovery);
          state = reduceAuthFlow(state, { type: 'discovery-loaded', email: '', methods });
        } else if (action.type === 'start-browser') {
          if (action.kind === 'social' ? !providerConfig?.social.some(provider => provider === action.providerOrConnectionId)
            : !methods.some(method => method.type === 'sso' && method.connectionId === action.providerOrConnectionId)) {
            throw new AuthApiError('INVALID_AUTH_ACTION', 400, 'Login method is unavailable');
          }
          const verifier = crypto.randomBytes(32).toString('base64url');
          const { clientState, pollSecret } = createDesktopPollCredentials();
          const authorizeUrl = deps.client.buildAuthorizeUrl({ kind: action.kind,
            providerOrConnectionId: action.providerOrConnectionId, redirectUri: deps.hostedCallbackUrl,
            codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: clientState });
          outcome = null;
          state = reduceAuthFlow(state, { type: 'browser-started', label: action.label });
          flight = (async () => {
            const callback = await runHostedCallbackPolling({
              poll: () => deps.client.pollDesktopAuthorization(pollSecret, { signal }),
              sleep: ms => sleep(ms, undefined, { signal }).then(() => {}),
              now: Date.now, signal, timeoutMs: 5 * 60_000,
            });
            signal.throwIfAborted();
            if ('error' in callback) throw new AuthApiError(callback.error, 400, 'Browser login failed');
            await accept(await deps.client.exchangeAuthorizationCode(callback.code, verifier), signal);
          })().catch(error => { if (!signal.aborted) fail(error); }).finally(() => {
            flight = null;
            releaseFinishedController();
          });
          return { ...result(), authorizeUrl };
        } else if (action.type === 'select-account' && outcome?.status === 'select_account') {
          if (!outcome.accounts.some(account => account.id === action.accountId)) throw new AuthApiError('INVALID_AUTH_ACTION', 400, 'Unknown account');
          await accept(await deps.client.selectAccount(outcome.loginTicket, action.accountId), signal);
        } else if (action.type === 'request-sso-verification-code' && outcome?.status === 'sso_verification_required') {
          await deps.client.requestSsoVerificationCode(outcome.verificationTicket);
          signal.throwIfAborted();
          state = reduceAuthFlow(state, { type: 'sso-verification-code-requested', channel: outcome.channel, targetMasked: outcome.targetMasked });
        } else if (action.type === 'verify-sso-verification' && outcome?.status === 'sso_verification_required') {
          await accept(await deps.client.verifySsoVerification(outcome.verificationTicket, action.code), signal);
        } else throw new AuthApiError('NOT_SUPPORTED', 400, 'Login action is unavailable');
        return result();
      } catch (error) { return fail(error); }
      finally {
        finishPending?.();
        pending = null;
        releaseFinishedController();
      }
    },
    async cancel() { await cancel(); },
    async releaseCaller(caller: string) { if (controller === caller) await cancel(); },
  };
}
