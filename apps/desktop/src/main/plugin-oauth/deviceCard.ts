import { randomBytes, randomUUID } from 'node:crypto';
import {
  PLUGIN_OAUTH_TTL_MS,
  parsePluginAuthorizationRequest,
  type PluginAuthorizationRequest,
  type PluginAuthorizationResult,
  type PluginOauthCallback,
  type PluginDeviceOpened,
} from '@cindy/device-link';
import {
  openAuthorizationOffer,
  type AuthorizationAdapterHandle,
} from './authorizationAdapters.js';
import type {
  GhostSetupInteractionBridge,
  GhostSetupInteractionSnapshot,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import { getRemoteOauthContext, type RemoteOauthContext } from './context.js';

export interface DeviceAuthorizationHandle {
  opened: Promise<void>;
  finish(ok: boolean): void;
  dispose(): void;
}
export interface DeviceAuthorizationInput {
  ghost: { id: string; name: string };
  sessionId: string;
  url: string;
  userCode?: string;
  signal: AbortSignal;
  assertCurrent(): void;
  cancel(): void;
}

export interface PluginAuthorizationHandle extends DeviceAuthorizationHandle {
  result: Promise<PluginAuthorizationResult>;
}
export interface PluginAuthorizationInput extends Omit<
  DeviceAuthorizationInput,
  'url' | 'userCode'
> {
  request: PluginAuthorizationRequest;
}
export interface AuthorizationCardDeps {
  bridge: GhostSetupInteractionBridge;
  openExternal(url: string): Promise<void>;
  copyDeviceCode?(code: string): () => void;
  copy: { title: string; description: string };
}

/** Legacy URL-only callers retain their existing negotiated device offer. */
export function openDeviceAuthorizationCard(
  input: DeviceAuthorizationInput,
  deps: AuthorizationCardDeps,
): DeviceAuthorizationHandle {
  return openCard(
    {
      ...input,
      request: {
        kind: 'device',
        url: input.url,
        ...(input.userCode === undefined ? {} : { userCode: input.userCode }),
      },
    },
    deps,
    true,
  );
}

/** One lifecycle for device codes, browser/QR confirmation and CLI PKCE callbacks. */
export function openPluginAuthorizationCard(
  input: PluginAuthorizationInput,
  deps: AuthorizationCardDeps,
): PluginAuthorizationHandle {
  return openCard(input, deps, false);
}

function openCard(
  input: PluginAuthorizationInput,
  deps: AuthorizationCardDeps,
  legacy: boolean,
): PluginAuthorizationHandle {
  input.assertCurrent();
  const request = parsePluginAuthorizationRequest(input.request);
  const url = request.url;
  const expiresAt = Math.min(
    Date.now() + PLUGIN_OAUTH_TTL_MS,
    request.kind === 'loopback' ? Infinity : (request.expiresAt ?? Infinity),
  );
  if (expiresAt <= Date.now()) throw new Error('PLUGIN_AUTHORIZATION_EXPIRED');
  const requestId = randomUUID();
  const actionId = 'device-authorization';
  const lifetime = new AbortController();
  let context: RemoteOauthContext | undefined;
  let begun = false;
  let opened = false;
  let settled = false;
  let providerRejected = false;
  let clearDeviceCode: (() => void) | undefined;
  let localAdapter: AuthorizationAdapterHandle | undefined;
  let resolveResult!: (result: PluginAuthorizationResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<PluginAuthorizationResult>((yes, no) => {
    resolveResult = yes;
    rejectResult = no;
  });
  void result.catch(() => {});
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const openedPromise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void openedPromise.catch(() => {});
  let snapshot: GhostSetupInteractionSnapshot = {
    kind: 'plugin_setup',
    requestId,
    revision: 0,
    ghost: input.ghost,
    steps: [
      {
        id: actionId,
        groupId: actionId,
        groupMode: 'any_of',
        title: deps.copy.title,
        description: deps.copy.description.replace('{{host}}', new URL(url).hostname),
        phase: 'pending',
        action: { id: actionId, kind: 'oauth_connect' },
      },
    ],
  };
  const assertCurrent = () => {
    if (settled || input.signal.aborted || lifetime.signal.aborted || Date.now() >= expiresAt)
      throw new Error('DEVICE_AUTHORIZATION_UNAVAILABLE');
    input.assertCurrent();
    context?.assertCurrent();
  };
  const update = (phase: 'waiting_external' | 'satisfied' | 'failed', terminal = false) => {
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      ...(terminal ? { terminal: true } : {}),
      steps: snapshot.steps.map((step) => ({
        ...step,
        phase,
        ...(phase === 'failed' ? { errorCode: 'AUTH_FAILED' as const } : {}),
      })),
    };
    deps.bridge.update(snapshot);
  };
  const finish = (ok: boolean) => {
    if (settled) return;
    let valid = false;
    try {
      assertCurrent();
      valid = true;
    } catch {
      /* Stale completions cannot become success. */
    }
    const success = ok && opened && valid && !providerRejected;
    settled = true;
    // Finish the transaction before the card becomes terminal and closes its binding.
    context?.cancelled?.removeEventListener('abort', cancel);
    context?.finish(success);
    lifetime.abort();
    input.signal.removeEventListener('abort', cancel);
    clearTimeout(timer);
    clearDeviceCode?.();
    localAdapter?.close(success ? 'completed' : 'ended');
    if (!opened) rejectResult(new Error('DEVICE_AUTHORIZATION_UNAVAILABLE'));
    if (!opened) reject(new Error('DEVICE_AUTHORIZATION_UNAVAILABLE'));
    update(success ? 'satisfied' : 'failed', true);
    deps.bridge.complete(requestId);
    const dismiss = setTimeout(
      () => deps.bridge.close(requestId, success ? 'completed' : 'cancelled'),
      1500,
    );
    dismiss.unref?.();
  };
  const cancel = () => {
    finish(false);
    input.cancel();
  };
  const timer = setTimeout(cancel, Math.max(1, expiresAt - Date.now()));
  timer.unref?.();
  input.signal.addEventListener('abort', cancel, { once: true });
  try {
    deps.bridge.open(input.sessionId, snapshot, (command, responseTarget) => {
      if (command.action === 'cancel') {
        if (command.cleanupReason || command.expectedRevision === snapshot.revision) cancel();
        return;
      }
      if (begun || command.expectedRevision !== snapshot.revision || command.actionId !== actionId)
        return;
      assertCurrent();
      const remote = getRemoteOauthContext();
      // Generic remote run_action cannot fall through to opening a cloud browser.
      if (!remote && (!responseTarget || responseTarget.isDestroyed())) return;
      begun = true;
      context = remote;
      context?.cancelled?.addEventListener('abort', cancel, { once: true });
      update('waiting_external');
      void (async () => {
        assertCurrent();
        let response: PluginAuthorizationResult = { kind: 'opened' };
        if (!legacy) {
          const offer = {
            kind: 'authorization' as const,
            state: randomBytes(32).toString('base64url'),
            request,
          };
          let callback: PluginOauthCallback | PluginDeviceOpened;
          if (remote) {
            if (!remote.authorizePlugin || !remote.cancelled)
              throw new Error('PLUGIN_AUTHORIZATION_UNSUPPORTED');
            callback = await remote.authorizePlugin(offer, lifetime.signal);
          } else if (request.kind === 'loopback') {
            // The source CLI already owns its local callback listener. A local
            // browser delivers directly; never bind its port or forward HTTP.
            await deps.openExternal(request.url);
            assertCurrent();
            callback = { kind: 'device-opened', state: offer.state };
          } else {
            let receive!: (value: PluginOauthCallback | PluginDeviceOpened) => void;
            let fail!: (error: Error) => void;
            const waiting = new Promise<PluginOauthCallback | PluginDeviceOpened>((yes, no) => {
              receive = yes;
              fail = no;
            });
            void waiting.catch(() => {});
            const abort = () => fail(new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE'));
            lifetime.signal.addEventListener('abort', abort, { once: true });
            try {
              localAdapter = await openAuthorizationOffer(offer, {
                ...deps,
                deadline: expiresAt,
                signal: lifetime.signal,
                assertCurrent,
                failed: cancel,
                deliver: async (value) => {
                  assertCurrent();
                  receive(value);
                },
              });
              callback = await waiting;
            } finally {
              lifetime.signal.removeEventListener('abort', abort);
            }
          }
          if (request.kind === 'loopback' && remote) {
            if ('kind' in callback) throw new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE');
            providerRejected = 'error' in callback;
            response = { ...callback, kind: 'callback', state: request.state };
          } else if (!('kind' in callback)) throw new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE');
        } else if (remote) {
          if (!remote.authorizeDevice || !remote.cancelled || request.kind !== 'device')
            throw new Error('DEVICE_AUTHORIZATION_UNAVAILABLE');
          await remote.authorizeDevice(
            {
              kind: 'device',
              authorizeUrl: url,
              state: randomBytes(32).toString('base64url'),
              ...(request.userCode !== undefined ? { userCode: request.userCode } : {}),
            },
            lifetime.signal,
          );
        } else {
          if (request.kind === 'device' && request.userCode !== undefined) {
            if (!deps.copyDeviceCode) throw new Error('DEVICE_AUTHORIZATION_UNAVAILABLE');
            clearDeviceCode = deps.copyDeviceCode(request.userCode);
          }
          await deps.openExternal(url);
          if (responseTarget!.isDestroyed()) throw new Error('DEVICE_AUTHORIZATION_UNAVAILABLE');
        }
        assertCurrent();
        opened = true;
        resolve();
        resolveResult(response);
      })().catch(cancel);
    });
    if (input.signal.aborted) cancel();
  } catch {
    cancel();
  }
  return { opened: openedPromise, result, finish, dispose: () => finish(false) };
}
