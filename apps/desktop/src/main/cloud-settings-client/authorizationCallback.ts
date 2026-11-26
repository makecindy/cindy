import { randomBytes } from 'node:crypto';
import { parseAuthorizationCallbackUrl } from '@cindy/device-link';
import type { ManagementPrompt } from '../../shared/settingsManagement';
import { listenForOauthCallback } from '../plugin-oauth/loopbackListener';
import { CloudClientError } from './transport';

/** Main-only adapter for the existing cloud management callback command.
 * The cloud CLI retains PKCE, token exchange and credential storage. */
export function createCloudAuthorizationCallback(input: {
  prompt: ManagementPrompt;
  assertCurrent(): void;
  submit(value: string): Promise<void>;
  now(): number;
}) {
  let closed = false;
  let claimed = false;
  let listener: Awaited<ReturnType<typeof listenForOauthCallback>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let validateManual: ((value: string) => void) | undefined;
  const deadline = Math.min(input.prompt.expiresAt, input.now() + 5 * 60_000);
  const check = () => {
    input.assertCurrent();
    if (closed || input.now() >= deadline) throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
  };
  const stop = (drain: boolean) => {
    closed = true;
    clearTimeout(timer);
    if (listener) void (drain ? listener.drain() : listener.close());
  };
  const claim = () => {
    check();
    if (claimed) throw new CloudClientError('CLOUD_SETTINGS_BUSY');
    claimed = true;
  };
  const ready = (async () => {
    try {
      check();
      const authorize = new URL(input.prompt.url);
      const redirects = [
        ...authorize.searchParams.getAll('redirect_uri'),
        ...authorize.searchParams.getAll('callback_url'),
      ];
      const states = authorize.searchParams.getAll('state');
      if (
        input.prompt.kind !== 'callback' ||
        authorize.protocol !== 'https:' ||
        authorize.username ||
        authorize.password ||
        authorize.hash ||
        redirects.length !== 1 ||
        states.length !== 1 ||
        !/^[A-Za-z0-9._~-]{16,512}$/.test(states[0]!)
      )
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      const endpoint = new URL(parseAuthorizationCallbackUrl(redirects[0]));
      validateManual = (value) => {
        const url = new URL(value.trim());
        if (
          url.origin !== endpoint.origin ||
          url.pathname !== endpoint.pathname ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.get('state') !== states[0] ||
          url.searchParams.getAll('code').length + url.searchParams.getAll('error').length !== 1
        )
          throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      };
      listener = await listenForOauthCallback(
        {
          authorizeUrl: authorize.href,
          callbackUrl: endpoint.href,
          state: randomBytes(32).toString('base64url'),
          corsOrigins: [authorize.origin],
          corsHosts: [],
        },
        async (callback) => {
          claim();
          const value = new URL(endpoint.href);
          value.searchParams.set('state', states[0]!);
          if ('code' in callback) value.searchParams.set('code', callback.code);
          else value.searchParams.set('error', callback.error);
          try {
            await input.submit(value.href);
          } finally {
            stop(true);
          }
        },
        check,
        states[0],
      );
      check();
      timer = setTimeout(() => stop(false), deadline - input.now());
      timer.unref();
    } catch {
      stop(false);
      // No provider URL, callback code or underlying socket error crosses IPC.
      throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
    }
  })();
  return {
    url: input.prompt.url,
    ready,
    close: () => stop(false),
    finish: () => stop(true),
    claimManual(value: string) {
      if (!validateManual) throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      try {
        validateManual(value);
      } catch {
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      }
      claim();
      stop(false);
    },
  };
}
