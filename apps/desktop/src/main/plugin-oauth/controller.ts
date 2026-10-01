import {
  PLUGIN_OAUTH_TTL_MS,
  parsePluginDeviceOffer,
  parsePluginSecretOffer,
  parsePluginSecretValue,
  parsePluginSecretPresentation,
  type PluginSecretPresentation,
  parsePluginConnectionOffer,
  parsePluginConnectionValue,
  parsePluginConnectionPresentation,
  type PluginConnectionInput,
  type PluginConnectionPresentation,
  oauthId,
  type PluginOauthAction,
  type PluginOauthCallback,
  type PluginDeviceOpened,
  type PluginOauthOffer,
  type PluginOauthRequest,
} from '@cindy/device-link';
import { OauthBox } from './box.js';
import {
  openAuthorizationOffer,
  type AuthorizationAdapterHandle,
} from './authorizationAdapters.js';
import type {
  PluginOauthDeviceCodePrompt,
  PluginOauthDeviceCodeClose,
} from '../../shared/pluginOauthDeviceCode.js';
import { listenForOauthCallback } from './loopbackListener.js';
export { listenForOauthCallback } from './loopbackListener.js';

const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
/** These URLs come only from the encrypted, registered Host transaction. */
export function parseOauthOffer(raw: unknown): PluginOauthOffer {
  const v = object(raw);
  if (
    Object.keys(v).sort().join(',') !== 'authorizeUrl,callbackUrl,corsHosts,corsOrigins,state' ||
    typeof v.authorizeUrl !== 'string' ||
    v.authorizeUrl.length > 16_384 ||
    typeof v.callbackUrl !== 'string' ||
    v.callbackUrl.length > 2048 ||
    typeof v.state !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state) ||
    !Array.isArray(v.corsOrigins) ||
    v.corsOrigins.length > 64 ||
    !Array.isArray(v.corsHosts) ||
    v.corsHosts.length > 128 ||
    v.corsHosts.some((h) => typeof h !== 'string' || !/^(?:\*\.)?[A-Za-z0-9.-]{1,253}$/.test(h))
  )
    throw fail();
  const authorize = new URL(v.authorizeUrl);
  const callback = new URL(v.callbackUrl);
  if (
    authorize.protocol !== 'https:' ||
    authorize.username ||
    authorize.password ||
    authorize.hash ||
    authorize.searchParams.getAll('state').length !== 1 ||
    authorize.searchParams.get('state') !== v.state ||
    authorize.searchParams.get('response_type') !== 'code' ||
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    !callback.port ||
    Number(callback.port) < 1 ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    /[\x00-\x20]/.test(v.callbackUrl)
  )
    throw fail();
  const corsOrigins = v.corsOrigins.map((origin) => {
    if (typeof origin !== 'string' || origin.length > 1024) throw fail();
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    )
      throw fail();
    return origin;
  });
  return {
    authorizeUrl: authorize.toString(),
    callbackUrl: callback.toString(),
    state: v.state,
    corsOrigins,
    corsHosts: v.corsHosts as string[],
  };
}

export interface OauthControllerDeps {
  /** Supplied only by the dedicated local input IPC, never generic assist or a Node adapter. */
  secretValue?: string;
  secretPresentation?: PluginSecretPresentation;
  connectionValue?: PluginConnectionInput;
  connectionPresentation?: PluginConnectionPresentation;
  invoke(request: PluginOauthRequest): Promise<unknown>;
  openExternal(url: string): Promise<void>;
  copyDeviceCode?(code: string): () => void;
  presentBrowserAuthorization?(
    expiresAt: number,
    reopen: () => Promise<void>,
  ): PluginOauthDeviceCodeClose;
  presentDeviceCode?(
    prompt: PluginOauthDeviceCodePrompt,
    clearClipboard: () => void,
  ): PluginOauthDeviceCodeClose;
  assertCurrent(): void;
  now?: () => number;
  pause?: () => Promise<void>;
}
/** Runs only behind the trusted Desktop click IPC. Returns status, never URL/code/token. */
export async function assistPluginOauth(
  deps: OauthControllerDeps,
  action: PluginOauthAction,
): Promise<{ accepted: true }> {
  try {
    return await runAuthorization(deps, action);
  } finally {
    // Capability/handshake failures happen before a transaction exists too.
    deps.secretValue = undefined;
    deps.connectionValue = undefined;
  }
}

async function runAuthorization(
  deps: OauthControllerDeps,
  action: PluginOauthAction,
): Promise<{ accepted: true }> {
  const now = deps.now ?? Date.now;
  const deadline = now() + PLUGIN_OAUTH_TTL_MS;
  deps.assertCurrent();
  const caps = object(await deps.invoke({ op: 'capabilities' }));
  if (caps.version !== 1 || caps.callback !== 'desktop-loopback' || caps.encrypted !== true)
    throw fail();
  if (deps.secretValue !== undefined && caps.secretSubmission !== true) throw fail();
  if (
    deps.connectionValue !== undefined &&
    (caps.connectionSubmission !== true || deps.secretValue !== undefined)
  )
    throw fail();
  deps.assertCurrent();
  const key = new OauthBox();
  const deviceUserCode = caps.deviceUserCode === true && !!deps.copyDeviceCode;
  const start = object(
    await deps.invoke({
      op: 'start',
      ...action,
      publicKey: key.publicKey,
      ...(deviceUserCode ? { deviceUserCode: true } : {}),
      ...(caps.authorizationV1 === true ? { authorizationV1: true } : {}),
      ...(deps.secretValue !== undefined ? { secretSubmission: true } : {}),
      ...(deps.connectionValue !== undefined ? { connectionSubmission: true } : {}),
    }),
  );
  if (
    !oauthId(start.id) ||
    typeof start.publicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{59}$/.test(start.publicKey)
  )
    throw fail();
  const id = start.id;
  const peerKey = start.publicKey;
  const deliverSealedCallback = async (box: string) => {
    deps.assertCurrent();
    const result = object(await deps.invoke({ op: 'callback', id, box }));
    if (result.accepted !== true) throw fail();
  };
  const deliverCallback = async (callback: PluginOauthCallback | PluginDeviceOpened) => {
    deps.assertCurrent();
    await deliverSealedCallback(key.seal(peerKey, id, 'callback', callback));
  };
  let listener: { close(): void } | undefined;
  let adapter: AuthorizationAdapterHandle | undefined;
  let opened = false;
  let finished = false;
  let callbackFailed = false;
  let clearDeviceCode: (() => void) | undefined;
  let closeDeviceCode: PluginOauthDeviceCodeClose | undefined;
  try {
    while (now() < deadline) {
      deps.assertCurrent();
      if (callbackFailed) throw fail();
      const status = object(await deps.invoke({ op: 'status', id }));
      deps.assertCurrent();
      if (status.phase === 'succeeded') {
        finished = true;
        return { accepted: true };
      }
      if (status.phase === 'failed' || status.phase === 'cancelled') throw fail();
      if (!['starting', 'authorizing', 'exchanging'].includes(String(status.phase))) throw fail();
      if (status.phase === 'authorizing' && !opened) {
        if (typeof status.offer !== 'string') throw fail();
        const rawOffer = object(key.open(peerKey, id, 'offer', status.offer));
        if (rawOffer.kind === 'connection-entry') {
          if (caps.connectionSubmission !== true || deps.connectionValue === undefined)
            throw fail();
          const offer = parsePluginConnectionOffer(rawOffer);
          if (
            JSON.stringify(offer.presentation) !==
            JSON.stringify(parsePluginConnectionPresentation(deps.connectionPresentation))
          )
            throw fail();
          const payload = parsePluginConnectionValue({
            kind: 'connection-value',
            state: offer.state,
            value: deps.connectionValue,
          });
          deps.assertCurrent();
          const sealed = key.seal(peerKey, id, 'callback', payload);
          deps.connectionValue = undefined;
          await deliverSealedCallback(sealed);
          opened = true;
          continue;
        }
        // A connection form cannot be reinterpreted as a free-form secret or OAuth action.
        if (deps.connectionValue !== undefined) throw fail();
        if (rawOffer.kind === 'secret-entry') {
          if (caps.secretSubmission !== true || deps.secretValue === undefined) throw fail();
          const offer = parsePluginSecretOffer(rawOffer);
          if (
            JSON.stringify(offer.presentation) !==
            JSON.stringify(parsePluginSecretPresentation(deps.secretPresentation))
          )
            throw fail();
          const payload = parsePluginSecretValue({
            kind: 'secret-value',
            state: offer.state,
            value: deps.secretValue,
          });
          if (payload.value.length > offer.presentation.maxLength) throw fail();
          deps.assertCurrent();
          const sealed = key.seal(peerKey, id, 'callback', payload);
          deps.secretValue = undefined;
          await deliverSealedCallback(sealed);
          opened = true;
          continue;
        }
        // Never send an input secret to a transaction that asks for another mode.
        if (deps.secretValue !== undefined) throw fail();
        if (rawOffer.kind === 'authorization') {
          if (caps.authorizationV1 !== true) throw fail();
          adapter = await openAuthorizationOffer(rawOffer, {
            ...deps,
            deadline,
            failed: () => {
              callbackFailed = true;
            },
            copyDeviceCode: deviceUserCode ? deps.copyDeviceCode : undefined,
            deliver: deliverCallback,
          });
          opened = true;
          continue;
        }
        if (rawOffer.kind === 'device') {
          if (caps.deviceAuthorization !== true) throw fail();
          const offer = parsePluginDeviceOffer(rawOffer);
          deps.assertCurrent();
          if (offer.userCode !== undefined) {
            if (!deviceUserCode || !deps.copyDeviceCode) throw fail();
            clearDeviceCode = deps.copyDeviceCode(offer.userCode);
            closeDeviceCode = deps.presentDeviceCode?.(
              { userCode: offer.userCode, authorizeUrl: offer.authorizeUrl, expiresAt: deadline },
              clearDeviceCode,
            );
          }
          if (!closeDeviceCode)
            closeDeviceCode = deps.presentBrowserAuthorization?.(deadline, () =>
              deps.openExternal(offer.authorizeUrl),
            );
          await deps.openExternal(offer.authorizeUrl);
          deps.assertCurrent();
          await deliverCallback({ kind: 'device-opened', state: offer.state });
          opened = true;
          continue; // Browser open is not authorization completion. Keep observing the cloud operation.
        }
        const offer = parseOauthOffer(rawOffer);
        listener = await listenForOauthCallback(
          offer,
          async (callback) => {
            try {
              await deliverCallback(callback);
            } catch {
              callbackFailed = true;
              throw fail();
            }
          },
          deps.assertCurrent,
        );
        deps.assertCurrent();
        closeDeviceCode = deps.presentBrowserAuthorization?.(deadline, () =>
          deps.openExternal(offer.authorizeUrl),
        );
        await deps.openExternal(offer.authorizeUrl);
        opened = true;
      }
      await (deps.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 500)));
    }
    throw fail();
  } finally {
    deps.secretValue = undefined;
    deps.connectionValue = undefined;
    listener?.close();
    adapter?.close(finished ? 'completed' : now() >= deadline ? 'expired' : 'ended');
    clearDeviceCode?.();
    closeDeviceCode?.(finished ? 'completed' : now() >= deadline ? 'expired' : 'ended');
    if (!finished) await deps.invoke({ op: 'cancel', id }).catch(() => {});
  }
}
