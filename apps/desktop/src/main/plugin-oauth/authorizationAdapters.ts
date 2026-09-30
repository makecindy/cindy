import {
  parsePluginAuthorizationOffer,
  PLUGIN_OAUTH_TTL_MS,
  type PluginAuthorizationOffer,
  type PluginAuthorizationRequest,
  type PluginOauthCallback,
  type PluginDeviceOpened,
} from '@cindy/device-link';
import type {
  PluginOauthDeviceCodeClose,
  PluginOauthDeviceCodePrompt,
} from '../../shared/pluginOauthDeviceCode.js';
import { listenForOauthCallback } from './loopbackListener.js';

/** Transport-independent UI adapters. Only a validated Host transaction supplies an offer. */
export interface AuthorizationAdapterDeps {
  openExternal(url: string): Promise<void>;
  copyDeviceCode?(code: string): () => void;
  presentBrowserAuthorization?(
    expiresAt: number,
    reopen: () => Promise<void>,
  ): PluginOauthDeviceCodeClose;
  presentDeviceCode?(
    prompt: PluginOauthDeviceCodePrompt,
    clear: () => void,
  ): PluginOauthDeviceCodeClose;
  deliver(callback: PluginOauthCallback | PluginDeviceOpened): Promise<void>;
  assertCurrent(): void;
  failed(): void;
  deadline: number;
  now?: () => number;
  signal?: AbortSignal;
}
export interface AuthorizationAdapterHandle {
  close(phase?: 'completed' | 'expired' | 'ended'): void;
}
type Adapter = (
  offer: PluginAuthorizationOffer,
  deps: AuthorizationAdapterDeps,
) => Promise<AuthorizationAdapterHandle>;
const fail = () => new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE');

async function openBrowser(
  offer: PluginAuthorizationOffer,
  deps: AuthorizationAdapterDeps,
): Promise<AuthorizationAdapterHandle> {
  const request = offer.request;
  let clear: (() => void) | undefined;
  let dismiss: PluginOauthDeviceCodeClose | undefined;
  const close = (phase: 'completed' | 'expired' | 'ended' = 'ended') => {
    clear?.();
    dismiss?.(phase);
  };
  try {
    if (request.kind === 'device' && request.userCode !== undefined) {
      if (!deps.copyDeviceCode) throw fail();
      clear = deps.copyDeviceCode(request.userCode);
      dismiss = deps.presentDeviceCode?.(
        {
          userCode: request.userCode,
          authorizeUrl: request.url,
          expiresAt: Math.min(deps.deadline, request.expiresAt ?? deps.deadline),
        },
        clear,
      );
    }
    if (!dismiss) {
      dismiss = deps.presentBrowserAuthorization?.(deps.deadline, async () => {
        deps.assertCurrent();
        await deps.openExternal(request.url);
        deps.assertCurrent();
      });
    }
    await deps.openExternal(request.url);
    deps.assertCurrent();
    await deps.deliver({ kind: 'device-opened', state: offer.state });
    return { close };
  } catch {
    close();
    throw fail();
  }
}

async function openLoopback(
  offer: PluginAuthorizationOffer,
  deps: AuthorizationAdapterDeps,
): Promise<AuthorizationAdapterHandle> {
  const request = offer.request;
  if (request.kind !== 'loopback') throw fail();
  // The provider state can use the CLI's own encoding. The private wire callback
  // uses the independently generated bridge state; neither is rendered or logged.
  const listener = await listenForOauthCallback(
    {
      authorizeUrl: request.url,
      callbackUrl: request.callbackUrl,
      state: offer.state,
      corsOrigins: [new URL(request.url).origin],
      corsHosts: [],
    },
    async (callback) => {
      try {
        deps.assertCurrent();
        await deps.deliver(callback);
      } catch {
        deps.failed();
        throw fail();
      }
    },
    deps.assertCurrent,
    request.state,
  );
  let dismiss: PluginOauthDeviceCodeClose | undefined;
  try {
    deps.signal?.addEventListener('abort', listener.close, { once: true });
    deps.assertCurrent();
    dismiss = deps.presentBrowserAuthorization?.(deps.deadline, async () => {
      deps.assertCurrent();
      await deps.openExternal(request.url);
      deps.assertCurrent();
    });
    await deps.openExternal(request.url);
    deps.assertCurrent();
    return {
      close: (phase = 'ended') => {
        dismiss?.(phase);
        deps.signal?.removeEventListener('abort', listener.close);
        listener.close();
      },
    };
  } catch {
    dismiss?.('ended');
    deps.signal?.removeEventListener('abort', listener.close);
    listener.close();
    throw fail();
  }
}

/**
 * Adding a transport mode means adding one parser/adapter and negotiated support,
 * never another provider branch in card, IPC, broker or Agent dispatch.
 */
const adapters: Readonly<Record<PluginAuthorizationRequest['kind'], Adapter>> = Object.freeze({
  device: openBrowser,
  browser: openBrowser,
  loopback: openLoopback,
});

export async function openAuthorizationOffer(
  raw: unknown,
  deps: AuthorizationAdapterDeps,
): Promise<AuthorizationAdapterHandle> {
  const offer = parsePluginAuthorizationOffer(raw);
  const now = deps.now ?? Date.now;
  const expiresAt = Math.min(
    deps.deadline,
    now() + PLUGIN_OAUTH_TTL_MS,
    offer.request.kind === 'loopback' ? Infinity : (offer.request.expiresAt ?? Infinity),
  );
  const assertCurrent = () => {
    deps.assertCurrent();
    if (deps.signal?.aborted || now() >= expiresAt) throw fail();
  };
  assertCurrent();
  return adapters[offer.request.kind](offer, { ...deps, assertCurrent, deadline: expiresAt });
}
