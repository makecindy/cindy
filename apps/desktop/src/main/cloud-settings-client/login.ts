import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AuthApiError,
  ssoOrgDiscoveryToMethods,
  type CindyAuthClient,
  type ProviderConfig,
  type LoginMethod,
} from '@cindy/auth-client';
import type { CloudInstanceLoginView, CloudLoginAction } from '../../shared/cloudInstanceLogin';
import type { CloudClientCaller } from './service';
import {
  CloudClientError,
  CloudLoginRemoteError,
  type CloudClientIdentity,
  type CloudClientHttp,
} from './transport';
import { continuation } from './onboarding';
import { parseCloud, parseOwnedInstances, type CloudOwnedInstance } from './ownedInstances';

export interface CloudLoginAuth {
  client: Pick<CindyAuthClient, 'getProviders' | 'discover' | 'discoverSsoOrg' | 'requestCode'>;
  baseUrl: string;
}
export interface CloudLoginDependencies {
  identity(): CloudClientIdentity | null;
  http: CloudClientHttp;
  openExternal?: (url: string) => Promise<void>;
  loginAuth?: (deviceId: string) => CloudLoginAuth;
  now?: () => number;
}
const statusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), authorizeUrl: z.string().max(8192).optional() }),
  z.object({ status: z.literal('ready') }),
  z.object({ status: z.literal('failed'), code: z.string().max(128) }),
  z.object({
    status: z.literal('login-options'),
    step: z.enum(['choose', 'code', 'social', 'binding']),
    channel: z.enum(['phone', 'email']).optional(),
  }),
  z.object({
    status: z.literal('verification-required'),
    channel: z.enum(['sms', 'email']),
    targetMasked: z.string().max(256),
  }),
]);
interface Session {
  callerId: number;
  identity: CloudClientIdentity;
  target: CloudOwnedInstance;
  auth: CloudLoginAuth;
  providers: ProviderConfig;
  view: CloudInstanceLoginView;
  attempt?: { id: string; secret: string };
  expires: number;
  epoch: number;
  busy: boolean;
  org?: string;
  methods?: LoginMethod[];
}
const safeFailure = (error: unknown) =>
  error instanceof CloudLoginRemoteError || error instanceof AuthApiError
    ? /^[A-Z][A-Z0-9_]{0,100}$/u.test(error.code)
      ? error.code
      : 'AUTH_REQUEST_FAILED'
    : error instanceof CloudClientError
      ? error.code
      : 'AUTH_REQUEST_FAILED';

/** Native presentation over the existing CIS continuation protocol. This never
 * calls the local account switcher or adopts a cloud token into the Mac profile. */
export function createCloudInstanceLogin(deps: CloudLoginDependencies) {
  const sessions = new Map<string, Session>();
  const opening = new Map<number, symbol>();
  const now = deps.now ?? Date.now;
  function check(caller: CloudClientCaller, s: Session, epoch = s.epoch) {
    caller.assertCurrent();
    if (
      deps.identity()?.key !== s.identity.key ||
      sessions.get(s.view.handle) !== s ||
      s.epoch !== epoch
    )
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    if (s.expires <= now()) throw new CloudLoginRemoteError('LOGIN_ATTEMPT_EXPIRED');
  }
  function get(caller: CloudClientCaller, handle: string) {
    const s = sessions.get(handle);
    if (!s || s.callerId !== caller.id) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    check(caller, s);
    return s;
  }
  async function call(caller: CloudClientCaller, s: Session, path: string, body: unknown) {
    const epoch = s.epoch;
    check(caller, s, epoch);
    const result = await deps.http.request(
      deps.identity()!,
      path,
      'POST',
      body,
      AbortSignal.timeout(8000),
      () => check(caller, s, epoch),
    );
    check(caller, s, epoch);
    return result;
  }
  async function cancelAttempt(s: Session) {
    const cap = s.attempt;
    if (!cap) return;
    await deps.http.cancelLogin?.(s.identity.baseUrl, cap.id, cap.secret);
    s.attempt = undefined;
  }
  async function attempt(
    caller: CloudClientCaller,
    s: Session,
    org?: string,
    connectionId?: string,
  ) {
    if (s.attempt) return;
    const epoch = s.epoch;
    const result = await deps.http.request(
      deps.identity()!,
      '/instance-login/api/attempts',
      'POST',
      {
        instanceId: s.target.instanceId,
        ...(s.target.status.desiredState === 'stopped' && s.target.status.loginWakeSupported
          ? { wake: true }
          : {}),
        ...(org ? { org, connectionId } : {}),
      },
      AbortSignal.timeout(8000),
      () => undefined,
    );
    const cap = continuation(s.identity.baseUrl, result);
    try {
      check(caller, s, epoch);
    } catch (error) {
      void deps.http.cancelLogin?.(s.identity.baseUrl, cap.id, cap.secret).catch(() => undefined);
      throw error;
    }
    s.attempt = { id: cap.id, secret: cap.secret };
    s.expires = now() + 10 * 60_000;
  }
  async function operation(
    caller: CloudClientCaller,
    s: Session,
    suffix: string,
    body: object = {},
  ) {
    if (!s.attempt) throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
    return call(caller, s, `/instance-login/api/attempts/${s.attempt.id}/${suffix}`, {
      ...body,
      attemptSecret: s.attempt.secret,
    });
  }
  async function openAuth(caller: CloudClientCaller, s: Session, raw: string, path: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
    }
    const base = new URL(s.auth.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== path ||
      url.searchParams.get('device_id') !== s.target.deviceId ||
      url.searchParams.get('redirect_uri') !==
        `${s.auth.baseUrl.replace(/\/$/u, '')}/api/auth/desktop/callback`
    )
      throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
    if (!deps.openExternal) throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
    check(caller, s);
    await deps.openExternal(url.href);
    check(caller, s);
  }
  function project(s: Session, raw: unknown) {
    const value = parseCloud(statusSchema, raw);
    if (value.status === 'ready') s.view.complete = true;
    else if (value.status === 'failed') {
      const code = value.code === 'LOGIN_OWNERSHIP_MISMATCH' ? value.code : 'AUTH_LOGIN_FAILED';
      s.view.state = { step: 'error', code, recoverTo: 'identifier' };
      throw new CloudLoginRemoteError(code);
    } else if (value.status === 'verification-required') {
      const previous = s.view.state;
      s.view.state = {
        step: 'sso-verification',
        channel: value.channel,
        targetMasked: value.targetMasked,
        codeRequested: previous.step === 'sso-verification' && previous.codeRequested,
      };
    } else if (value.status === 'login-options' && value.step === 'binding' && value.channel) {
      if (s.view.state.step !== 'binding')
        s.view.state = { step: 'binding', bindType: value.channel, codeRequested: false };
    }
    return value;
  }
  async function startSso(
    caller: CloudClientCaller,
    s: Session,
    connectionId: string,
    label: string,
  ) {
    if (
      !s.target.status.ownership?.orgSlug ||
      !s.org ||
      !s.methods?.some((m) => m.type === 'sso' && m.connectionId === connectionId)
    )
      throw new CloudLoginRemoteError('LOGIN_OWNERSHIP_MISMATCH');
    await attempt(caller, s, s.org, connectionId);
    const status = project(s, await operation(caller, s, 'status'));
    if (status.status === 'pending' && status.authorizeUrl) {
      s.view.state = { step: 'browser-redirect', label };
      await openAuth(
        caller,
        s,
        status.authorizeUrl,
        `/api/auth/sso/${encodeURIComponent(connectionId)}/authorize`,
      );
    }
  }
  async function run(caller: CloudClientCaller, s: Session, action: CloudLoginAction) {
    switch (action.type) {
      case 'reset':
      case 'back':
      case 'cancel-browser':
        await cancelAttempt(s);
        s.methods = undefined;
        s.org = undefined;
        s.view.state = { step: 'identifier', providers: s.providers };
        return;
      case 'discover-sso-org': {
        // Keep the native enterprise-ID entry. Only the owning enterprise may
        // complete the attempt; a personal instance cannot become an org one.
        if (!s.target.status.ownership?.orgSlug)
          throw new CloudLoginRemoteError('LOGIN_OWNERSHIP_MISMATCH');
        const discovery = await s.auth.client.discoverSsoOrg(action.org);
        check(caller, s);
        s.org = action.org;
        s.methods = ssoOrgDiscoveryToMethods(discovery);
        if (s.methods.length === 1 && s.methods[0]!.type === 'sso')
          return startSso(caller, s, s.methods[0]!.connectionId, s.methods[0]!.connectionName);
        s.view.state = { step: 'method-choice', email: '', methods: s.methods };
        return;
      }
      case 'discover': {
        s.methods = await s.auth.client.discover(action.email);
        check(caller, s);
        s.org = s.target.status.ownership?.orgSlug ?? undefined;
        s.view.state = { step: 'method-choice', email: action.email, methods: s.methods };
        return;
      }
      case 'start-browser': {
        if (action.kind === 'sso')
          return startSso(caller, s, action.providerOrConnectionId, action.label);
        if (s.target.status.ownership?.orgSlug)
          throw new CloudLoginRemoteError('LOGIN_OWNERSHIP_MISMATCH');
        if (!s.providers.social.some((p) => p === action.providerOrConnectionId))
          throw new CloudLoginRemoteError('LOGIN_METHOD_UNAVAILABLE');
        await attempt(caller, s);
        const result = parseCloud(
          z.object({ status: z.literal('pending'), authorizeUrl: z.string().max(8192) }),
          await operation(caller, s, 'personal/social', {
            provider: action.providerOrConnectionId,
          }),
        );
        s.view.state = { step: 'browser-redirect', label: action.label };
        await openAuth(
          caller,
          s,
          result.authorizeUrl,
          `/api/auth/social/${action.providerOrConnectionId}/authorize`,
        );
        return;
      }
      case 'request-code': {
        if (s.target.status.ownership?.orgSlug)
          throw new CloudLoginRemoteError('LOGIN_OWNERSHIP_MISMATCH');
        if (!s.providers[action.kind]) throw new CloudLoginRemoteError('LOGIN_METHOD_UNAVAILABLE');
        await attempt(caller, s);
        parseCloud(
          z.object({ status: z.literal('prepared') }),
          await operation(caller, s, 'personal/prepare-code', {
            channel: action.kind,
            identifier: action.identifier,
          }),
        );
        await s.auth.client.requestCode(action.kind, action.identifier, {
          captchaToken: action.captchaToken,
        });
        check(caller, s);
        s.view.state = {
          step: 'verification-code',
          kind: action.kind,
          identifier: action.identifier,
        };
        return;
      }
      case 'verify-code': {
        const state = s.view.state;
        if (
          state.step !== 'verification-code' ||
          state.kind !== action.kind ||
          state.identifier !== action.identifier
        )
          throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
        project(s, await operation(caller, s, 'personal/verify', { code: action.code }));
        return;
      }
      case 'request-sso-verification-code':
        if (s.view.state.step !== 'sso-verification')
          throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
        await operation(caller, s, 'verification/request-code');
        s.view.state = { ...s.view.state, codeRequested: true };
        return;
      case 'verify-sso-verification':
        if (s.view.state.step !== 'sso-verification')
          throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
        project(s, await operation(caller, s, 'verification/verify', { code: action.code }));
        return;
      case 'request-binding-code': {
        const state = s.view.state;
        if (state.step !== 'binding') throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
        await operation(caller, s, 'personal/request-code', {
          channel: state.bindType,
          identifier: action.contact,
        });
        s.view.state = { ...state, contact: action.contact, codeRequested: true };
        return;
      }
      case 'verify-binding':
        if (s.view.state.step !== 'binding' || s.view.state.contact !== action.contact)
          throw new CloudLoginRemoteError('LOGIN_STATE_INVALID');
        project(s, await operation(caller, s, 'personal/verify', { code: action.code }));
        return;
    }
  }
  return {
    async start(caller: CloudClientCaller, deviceId: string): Promise<CloudInstanceLoginView> {
      caller.assertCurrent();
      const identity = deps.identity();
      if (!identity || !deps.loginAuth) throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      for (const [handle, s] of sessions)
        if (s.expires <= now()) {
          sessions.delete(handle);
          s.epoch++;
          if (!s.view.complete) void cancelAttempt(s).catch(() => undefined);
        }
      if (sessions.size >= 32 || opening.has(caller.id))
        throw new CloudClientError('CLOUD_SETTINGS_BUSY');
      const epoch = Symbol();
      opening.set(caller.id, epoch);
      const current = () => {
        caller.assertCurrent();
        if (opening.get(caller.id) !== epoch || deps.identity()?.key !== identity.key)
          throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      };
      try {
        const targets = parseOwnedInstances(
          await deps.http.request(
            identity,
            '/instance-login/api/manage/instances',
            'GET',
            undefined,
            AbortSignal.timeout(8000),
            current,
          ),
        );
        current();
        const target = targets.find((t) => t.deviceId === deviceId);
        if (!target?.status.loginRequired || !target.status.ownership)
          throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
        const auth = deps.loginAuth(deviceId),
          providers = await auth.client.getProviders();
        current();
        const view: CloudInstanceLoginView = {
          handle: randomUUID(),
          state: { step: 'identifier', providers },
          complete: false,
          captchaChallengeUrl: `${auth.baseUrl.replace(/\/$/u, '')}/captcha/turnstile`,
        };
        const s: Session = {
          identity,
          callerId: caller.id,
          target,
          auth,
          providers,
          view,
          epoch: 0,
          busy: false,
          expires: now() + 10 * 60_000,
        };
        sessions.set(view.handle, s);
        return structuredClone(view);
      } finally {
        if (opening.get(caller.id) === epoch) opening.delete(caller.id);
      }
    },
    async dispatch(caller: CloudClientCaller, handle: string, action: CloudLoginAction) {
      const s = get(caller, handle);
      if (s.busy || s.view.complete) throw new CloudClientError('CLOUD_SETTINGS_BUSY');
      s.busy = true;
      delete s.view.errorCode;
      delete s.view.retryAt;
      try {
        await run(caller, s, action);
        check(caller, s);
      } catch (error) {
        check(caller, s);
        s.view.errorCode = safeFailure(error);
        if (error instanceof AuthApiError) s.view.retryAt = error.retryAt;
      } finally {
        s.busy = false;
      }
      return structuredClone(s.view);
    },
    async poll(caller: CloudClientCaller, handle: string) {
      const s = get(caller, handle);
      if (
        !s.attempt ||
        s.busy ||
        s.view.complete ||
        !['browser-redirect', 'sso-verification'].includes(s.view.state.step)
      )
        return structuredClone(s.view);
      s.busy = true;
      try {
        project(s, await operation(caller, s, 'status'));
        check(caller, s);
      } catch (error) {
        check(caller, s);
        s.view.errorCode = safeFailure(error);
      } finally {
        s.busy = false;
      }
      return structuredClone(s.view);
    },
    async close(caller: CloudClientCaller, handle: string) {
      const s = sessions.get(handle);
      if (!s || s.callerId !== caller.id) return;
      caller.assertCurrent();
      sessions.delete(handle);
      s.epoch++;
      if (!s.view.complete) await cancelAttempt(s);
    },
    invalidate(callerId?: number) {
      for (const id of opening.keys())
        if (callerId === undefined || id === callerId) opening.delete(id);
      for (const [handle, s] of sessions)
        if (callerId === undefined || s.callerId === callerId) {
          sessions.delete(handle);
          s.epoch++;
          if (!s.view.complete) void cancelAttempt(s).catch(() => undefined);
        }
    },
  };
}
