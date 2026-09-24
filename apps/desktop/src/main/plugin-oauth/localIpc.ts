import {
  PLUGIN_OAUTH_CHANNEL,
  oauthId,
  parsePluginOauthAction,
  parsePluginSecretInput,
  parsePluginSecretPresentation,
  parsePluginConnectionInput,
  parsePluginConnectionPresentation,
  type InvokeResultPayload,
  type PluginOauthPeerIdentity,
} from '@cindy/device-link';
import { assistPluginOauth } from './controller.js';
import { capturePluginOauthPeer } from './runtime.js';
import { authenticateOauthController } from './authentication.js';
import type {
  LocalPluginSecretRequest,
  LocalPluginConnectionRequest,
} from '../../shared/pluginOauth.js';
import type {
  PluginOauthDeviceCodePrompt,
  PluginOauthDeviceCodeClose,
  PluginOauthDeviceCodeTarget,
} from '../../shared/pluginOauthDeviceCode.js';

const active = new Set<string>();
export interface LocalOauthDeps {
  owner(): string | null;
  assertTarget(deviceId: string): void;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  openExternal(url: string): Promise<void>;
  copyDeviceCode?(code: string): () => void;
  presentBrowserAuthorization?(
    target: PluginOauthDeviceCodeTarget,
    expiresAt: number,
    assertCurrent: () => void,
    reopen: () => Promise<void>,
  ): PluginOauthDeviceCodeClose;
  presentDeviceCode?(
    target: PluginOauthDeviceCodeTarget,
    prompt: PluginOauthDeviceCodePrompt,
    assertCurrent: () => void,
    clearClipboard: () => void,
  ): PluginOauthDeviceCodeClose;
  localDeviceId(): string;
  trustIdentity(target: PluginOauthPeerIdentity, assertCurrent: () => void): Promise<void>;
  identity(deviceId: string, assertCurrent: () => void): Promise<PluginOauthPeerIdentity>;
}
/** Renderer supplies only an opaque card action and its target. No caller-supplied URL/key. */
export async function handleAssistPluginOauth(
  deps: LocalOauthDeps,
  raw: unknown,
): Promise<{ accepted: true }> {
  return handleAuthorization(deps, raw);
}

async function handleAuthorization(
  deps: LocalOauthDeps,
  raw: unknown,
  secret?: Pick<LocalPluginSecretRequest, 'value' | 'presentation'>,
  connection?: Pick<LocalPluginConnectionRequest, 'value' | 'presentation'>,
): Promise<{ accepted: true }> {
  const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  const { deviceId, ghostId, ...rest } = raw as Record<string, unknown>;
  const action = parsePluginOauthAction(rest);
  const owner = deps.owner();
  if (!oauthId(deviceId) || !oauthId(ghostId) || !action || !owner) throw fail();
  const slot = `${deviceId}:${action.requestId}`;
  if (active.has(slot) || active.size >= 8) throw fail();
  const peerCurrent = capturePluginOauthPeer(deviceId);
  const assertCurrent = () => {
    peerCurrent();
    if (owner !== deps.owner()) throw fail();
    deps.assertTarget(deviceId);
  };
  assertCurrent();
  active.add(slot);
  try {
    const target = await deps.identity(deviceId, assertCurrent);
    assertCurrent();
    if (target.deviceId !== deviceId) throw fail();
    const exchange = await authenticateOauthController({
      target,
      trustIdentity: deps.trustIdentity,
      peer: deps.localDeviceId(),
      action,
      ghostId,
      assertCurrent,
      invoke: async (raw) => {
        // A vanished window may send an encrypted cancellation, but never under a new owner/peer generation.
        peerCurrent();
        if (owner !== deps.owner()) throw fail();
        const result = await deps.invoke(deviceId, PLUGIN_OAUTH_CHANNEL, [raw]);
        peerCurrent();
        if (owner !== deps.owner() || !result.ok) throw fail();
        return result.result;
      },
    });
    return await assistPluginOauth(
      {
        ...(secret ? { secretValue: secret.value, secretPresentation: secret.presentation } : {}),
        ...(connection
          ? { connectionValue: connection.value, connectionPresentation: connection.presentation }
          : {}),
        assertCurrent,
        openExternal: deps.openExternal,
        copyDeviceCode: deps.copyDeviceCode,
        presentBrowserAuthorization: (expiresAt, reopen) =>
          deps.presentBrowserAuthorization?.(
            { deviceId, ghostId, requestId: action.requestId, actionId: action.actionId },
            expiresAt,
            assertCurrent,
            reopen,
          ) ?? (() => {}),
        presentDeviceCode: (prompt, clearClipboard) =>
          deps.presentDeviceCode?.(
            { deviceId, ghostId, requestId: action.requestId, actionId: action.actionId },
            prompt,
            assertCurrent,
            clearClipboard,
          ) ?? (() => {}),
        invoke: async (request) => {
          // A closed/navigated window must still cancel its existing transaction.
          // Never send cancellation under a new owner or re-established peer.
          if (request.op === 'cancel') {
            peerCurrent();
            if (owner !== deps.owner()) throw fail();
          } else assertCurrent();
          const result = await exchange(request);
          if (request.op !== 'cancel') assertCurrent();
          return result;
        },
      },
      action,
    );
  } finally {
    active.delete(slot);
  }
}

/** One-shot local input IPC. The value cannot name a storage path, key or another action. */
export async function handleSubmitPluginSecret(
  deps: LocalOauthDeps,
  raw: unknown,
): Promise<{ accepted: true }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('PLUGIN_SECRET_UNAVAILABLE');
  const { value, presentation, ...target } = raw as Record<string, unknown>;
  return handleAuthorization(deps, target, {
    value: parsePluginSecretInput(value),
    presentation: parsePluginSecretPresentation(presentation),
  });
}

export async function handleSubmitPluginConnection(
  deps: LocalOauthDeps,
  raw: unknown,
): Promise<{ accepted: true }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('PLUGIN_CONNECTION_UNAVAILABLE');
  const { value, presentation, ...target } = raw as Record<string, unknown>;
  return handleAuthorization(deps, target, undefined, {
    value: parsePluginConnectionInput(value),
    presentation: parsePluginConnectionPresentation(presentation),
  });
}
