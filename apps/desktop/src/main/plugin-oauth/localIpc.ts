import {
  PLUGIN_OAUTH_CHANNEL,
  oauthId,
  oauthGhostId,
  parsePluginOauthAction,
  parsePluginSecretInput,
  parsePluginSecretPresentation,
  parsePluginConnectionInput,
  parsePluginConnectionPresentation,
  parseInputHandoffPresentation,
  parseInputHandoffSubmission,
  INPUT_HANDOFF_GHOST_ID,
  PLUGIN_OAUTH_TTL_MS,
  type InputHandoffPicture,
  type InputHandoffPresentation,
  type InputHandoffSubmission,
  type InvokeResultPayload,
  type PluginOauthPeerIdentity,
} from '@cindy/device-link';
import { randomUUID } from 'node:crypto';
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
  input?: {
    presentation: InputHandoffPresentation;
    submission?: InputHandoffSubmission;
    picture?(picture: InputHandoffPicture): Promise<InputHandoffSubmission>;
  },
): Promise<{ accepted: true }> {
  const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  const { deviceId, ghostId, ...rest } = raw as Record<string, unknown>;
  const action = parsePluginOauthAction(rest);
  const owner = deps.owner();
  if (!oauthId(deviceId) || !oauthGhostId(ghostId) || !action || !owner) throw fail();
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
        ...(input
          ? {
              inputPresentation: input.presentation,
              ...(input.submission ? { inputSubmission: input.submission } : {}),
              ...(input.picture ? { inputPicture: input.picture } : {}),
            }
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

/** 代输入 step for a task on another computer. The submission is never logged or echoed. */
export async function handleSubmitInputHandoff(
  deps: LocalOauthDeps,
  raw: unknown,
): Promise<{ accepted: true }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('INPUT_HANDOFF_UNAVAILABLE');
  const { submission, presentation, ...target } = raw as Record<string, unknown>;
  if ((target as { ghostId?: unknown }).ghostId !== INPUT_HANDOFF_GHOST_ID)
    throw new Error('INPUT_HANDOFF_UNAVAILABLE');
  const parsedPresentation = parseInputHandoffPresentation(presentation);
  const parsedSubmission = parseInputHandoffSubmission(submission);
  if (
    parsedPresentation.picture ||
    parsedPresentation.requestId !== (target as { requestId?: unknown }).requestId ||
    parsedPresentation.revision !== parsedSubmission.expectedRevision
  )
    throw new Error('INPUT_HANDOFF_UNAVAILABLE');
  return handleAuthorization(deps, target, undefined, undefined, {
    submission: parsedSubmission,
    presentation: parsedPresentation,
  });
}

interface PictureExchange {
  owner: number;
  revision: number;
  answer(submission: InputHandoffSubmission | null): void;
  done: Promise<{ accepted: true }>;
}
/** Open screenshot steps by token; each is one signed exchange waiting for the owner. */
const pictureExchanges = new Map<string, PictureExchange>();

/**
 * 代输入 screenshot step for a task on another computer: runs the signed
 * exchange up to the sealed offer and hands its picture to the requesting
 * window. The exchange then waits for `handleAnswerInputHandoffPicture`.
 * The picture is returned to that window only and never stored.
 */
export function handleOpenInputHandoffPicture(
  deps: LocalOauthDeps,
  raw: unknown,
  owner: number,
): Promise<{ token: string; picture: InputHandoffPicture }> {
  const fail = () => new Error('INPUT_HANDOFF_UNAVAILABLE');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Promise.reject(fail());
  const { presentation, ...target } = raw as Record<string, unknown>;
  let parsed: InputHandoffPresentation;
  try {
    parsed = parseInputHandoffPresentation(presentation);
  } catch {
    return Promise.reject(fail());
  }
  if (
    (target as { ghostId?: unknown }).ghostId !== INPUT_HANDOFF_GHOST_ID ||
    !parsed.picture ||
    parsed.requestId !== (target as { requestId?: unknown }).requestId ||
    parsed.revision !== (target as { expectedRevision?: unknown }).expectedRevision ||
    pictureExchanges.size >= 4
  )
    return Promise.reject(fail());
  const token = randomUUID();
  return new Promise((resolve, reject) => {
    const done = handleAuthorization(deps, target, undefined, undefined, {
      presentation: parsed,
      picture: (picture) =>
        new Promise<InputHandoffSubmission>((answered, declined) => {
          const timer = setTimeout(() => entry.answer(null), PLUGIN_OAUTH_TTL_MS);
          timer.unref?.();
          const entry: PictureExchange = {
            owner,
            revision: parsed.revision,
            answer: (submission) => {
              clearTimeout(timer);
              entry.answer = () => undefined;
              if (submission) answered(submission);
              else declined(fail());
            },
            done,
          };
          pictureExchanges.set(token, entry);
          resolve({ token, picture });
        }),
    });
    done.catch(reject).finally(() => {
      pictureExchanges.get(token)?.answer(null);
      pictureExchanges.delete(token);
    });
  });
}

/** The owner's tap or typing on an opened screenshot step; `null` closes it without acting. */
export async function handleAnswerInputHandoffPicture(
  raw: unknown,
  owner: number,
): Promise<{ accepted: boolean }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INPUT_HANDOFF_UNAVAILABLE');
  const { token, submission } = raw as Record<string, unknown>;
  const entry = typeof token === 'string' ? pictureExchanges.get(token) : undefined;
  if (!entry || entry.owner !== owner) return { accepted: false };
  // Closing waits for the exchange to wind down, so the same window can open the step again right away.
  const close = async () => {
    entry.answer(null);
    await entry.done.catch(() => undefined);
    return { accepted: false };
  };
  if (submission === null) return close();
  let parsed: InputHandoffSubmission;
  try {
    parsed = parseInputHandoffSubmission(submission);
  } catch {
    return close();
  }
  if (parsed.expectedRevision !== entry.revision) return close();
  entry.answer(parsed);
  try {
    await entry.done;
    return { accepted: true };
  } catch {
    return { accepted: false };
  }
}
