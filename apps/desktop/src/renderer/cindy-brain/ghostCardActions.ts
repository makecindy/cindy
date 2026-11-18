/**
 * Plugin card clicks, wherever the card's task runs.
 *
 * A card of a task on this computer goes to the local dispatcher as before. A card of a task on
 * another computer goes to that computer through the same `plugin-results` action and interaction
 * page lease the phone uses: the click is checked and dispatched there, by the plugin installed
 * there. Confirmations and model pickers the plugin opens while handling the click are read from
 * that page for a short time after each click and answered from this window.
 *
 * Model routes: a card and its plugin describe a model's location relative to the plugin's own
 * computer (no `agentDeviceId` = that computer). This window's picker describes it relative to
 * this computer. `routeForPicker` / `routeForHost` translate between the two.
 */
import {
  PLUGIN_COLLECTION,
  PLUGIN_PAGE_PRIMITIVE,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  type PluginModelPickerRequest,
  type PluginPageConfirm,
  type PluginPagePoll,
} from '@cindy/device-link';
import { readGhostCardFormChange } from '@cindy/maker-shared/ghost-card-form';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { GhostCardModelSelection } from '../../shared/ghost';
import { getGhostCardEntry, refreshRemoteCard, type GhostRemoteCardSource } from './ghostCardStore';

export interface GhostCardActionInput {
  prompt?: string;
  formValues?: Record<string, string>;
  formChange?: boolean;
  /** Relative to this computer, as the card's model menu shows it. */
  modelSelection?: GhostCardModelSelection;
  /** Remote mail cards only: a file uploaded from this computer for `mail:attach`. */
  mailAttachment?: { url: string; name: string };
}

/** Route one card action to the computer that owns the card. Never throws. */
export async function dispatchGhostCardAction(
  callId: string,
  actionId: string,
  input: GhostCardActionInput = {},
): Promise<{ ok: boolean }> {
  const entry = getGhostCardEntry(callId);
  try {
    if (entry?.status === 'ready' && entry.remote) {
      return await dispatchRemote(callId, entry.ghostId, entry.html, entry.remote, actionId, input);
    }
    // Local attachments use this computer's native picker inside the dispatcher.
    if (input.mailAttachment) return { ok: false };
    const api = window.electronAPI?.ghosts;
    if (!api?.dispatchCardAction) return { ok: false };
    // Same IPC call as before this module existed: only the arguments a click actually has.
    const args: unknown[] = [input.prompt, input.formValues, input.formChange, input.modelSelection];
    while (args.length && args[args.length - 1] === undefined) args.pop();
    return await (api.dispatchCardAction as (...values: unknown[]) => Promise<{ ok: boolean }>)(callId, actionId, ...args);
  } catch {
    return { ok: false };
  }
}

// ── Model route frames ────────────────────────────────────────────────────────

let selfDeviceId: string | null = null;
let selfDeviceRead: Promise<string | null> | null = null;

function readSelfDeviceId(): Promise<string | null> {
  if (selfDeviceId) return Promise.resolve(selfDeviceId);
  selfDeviceRead ??= window.electronAPI.deviceLink.listDevices()
    .then(({ devices }) => (selfDeviceId = devices.find((device) => device.isSelf)?.deviceId ?? null))
    .catch(() => null)
    .finally(() => { selfDeviceRead = null; });
  return selfDeviceRead;
}

/** Prepare model-route translation before a remote card's model menu opens. */
export function prepareRemoteModelRoutes(): void {
  void readSelfDeviceId();
}

/** A route stored on the task's computer, as this computer's model menu shows it. */
export function routeForPicker(
  route: GhostCardModelSelection | null | undefined,
  remote: Pick<GhostRemoteCardSource, 'deviceId'> | undefined,
): GhostCardModelSelection | null {
  if (!route) return null;
  if (!remote) return route;
  const { agentDeviceId, ...rest } = route;
  if (!agentDeviceId) return { ...rest, agentDeviceId: remote.deviceId };
  return agentDeviceId === selfDeviceId ? rest : route;
}

/** This computer's choice, as the task's computer understands it. Null when it cannot be expressed. */
export async function routeForHost(
  route: GhostCardModelSelection,
  remote: Pick<GhostRemoteCardSource, 'deviceId'>,
): Promise<GhostCardModelSelection | null> {
  const { agentDeviceId, ...rest } = route;
  if (agentDeviceId === remote.deviceId) return rest;
  if (agentDeviceId) return route;
  const self = await readSelfDeviceId();
  return self ? { ...rest, agentDeviceId: self } : null;
}

// ── Remote dispatch ───────────────────────────────────────────────────────────

/** The host closes an unused interaction page after two minutes; reopen well before that. */
const LEASE_IDLE_MS = 90_000;
/** Plugins ask for confirmation or a model right after a click; look for such requests this long. */
const PROMPT_WINDOW_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;

interface Lease {
  deviceId: string;
  pluginId: string;
  pageId: string;
  usedAt: number;
  owner: ReturnType<typeof getDataOwnerGeneration>;
}

const leases = new Map<string, Promise<Lease>>();
const leaseKey = (deviceId: string, pluginId: string) => `${deviceId}\n${pluginId}`;

async function invokePlugin<T>(deviceId: string, pluginId: string, actionId: string, input: Record<string, unknown> = {}): Promise<T> {
  const reply = await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [PLUGIN_PAGE_PRIMITIVE] },
    collectionId: PLUGIN_COLLECTION,
    resourceRef: { collectionId: PLUGIN_COLLECTION, kind: 'plugin', id: pluginId },
    actionId,
    input,
  }]);
  return (reply as { result?: T } | null)?.result as T;
}

function dropLease(key: string, lease?: Lease): void {
  leases.delete(key);
  stopPolling(key);
  if (lease && isDataOwnerGenerationCurrent(lease.owner))
    void invokePlugin(lease.deviceId, lease.pluginId, 'close', { pageId: lease.pageId }).catch(() => {});
}

async function acquireLease(deviceId: string, pluginId: string): Promise<Lease> {
  const key = leaseKey(deviceId, pluginId);
  const existing = leases.get(key);
  if (existing) {
    const lease = await existing.catch(() => null);
    if (lease && leases.get(key) === existing && isDataOwnerGenerationCurrent(lease.owner) && Date.now() - lease.usedAt < LEASE_IDLE_MS) return lease;
    if (leases.get(key) === existing) dropLease(key, lease ?? undefined);
  }
  const owner = getDataOwnerGeneration();
  const opening = invokePlugin<{ pageId?: unknown }>(deviceId, pluginId, 'open-interaction').then((result) => {
    if (typeof result?.pageId !== 'string') throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    return { deviceId, pluginId, pageId: result.pageId, usedAt: Date.now(), owner };
  });
  leases.set(key, opening);
  opening.catch(() => { if (leases.get(key) === opening) leases.delete(key); });
  return opening;
}

async function dispatchRemote(
  callId: string,
  pluginId: string,
  html: string,
  remote: GhostRemoteCardSource,
  actionId: string,
  input: GhostCardActionInput,
): Promise<{ ok: boolean }> {
  const modelSelection = input.modelSelection ? await routeForHost(input.modelSelection, remote) : undefined;
  if (modelSelection === null) return { ok: false };
  const key = leaseKey(remote.deviceId, pluginId);
  const lease = await acquireLease(remote.deviceId, pluginId);
  const formKey = input.formValues && !input.formChange ? readGhostCardFormChange(html) : null;
  try {
    lease.usedAt = Date.now();
    await window.electronAPI.deviceLink.invoke(remote.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
      client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['plugin-card-actions', 'plugin-card-forms'] },
      collectionId: 'plugin-results',
      resourceRef: { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify([remote.sessionId, callId]) },
      actionId,
      input: {
        revision: remote.revision,
        pageId: lease.pageId,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.formValues ? { formValues: input.formValues } : {}),
        ...(input.formChange ? { formChange: true } : {}),
        ...(formKey ? { formKey } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(input.mailAttachment ? { mailAttachment: input.mailAttachment } : {}),
      },
    }]);
  } catch {
    // The card may have changed there, or the page lapsed: show the current card, start afresh next time.
    if ((await leases.get(key)?.catch(() => null)) === lease) dropLease(key, lease);
    refreshRemoteCard(callId);
    return { ok: false };
  }
  startPolling(key, lease, callId);
  return { ok: true };
}

// ── Requests the plugin makes while handling a click ──────────────────────────

export type RemoteCardPrompt =
  | { kind: 'confirm'; callId: string; confirm: PluginPageConfirm }
  | { kind: 'model'; callId: string; request: PluginModelPickerRequest; remote: Pick<GhostRemoteCardSource, 'deviceId'> };

interface Poller {
  lease: Lease;
  callId: string;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
  prompt?: RemoteCardPrompt;
  /** Answered requests still listed by the host until its next state change. */
  answered: Set<string>;
}

const pollers = new Map<string, Poller>();
const promptListeners = new Set<() => void>();

function notifyPrompts(): void {
  for (const listener of [...promptListeners]) listener();
}

function stopPolling(key: string): void {
  const poller = pollers.get(key);
  if (!poller) return;
  if (poller.timer) clearTimeout(poller.timer);
  pollers.delete(key);
  if (poller.prompt) notifyPrompts();
}

function startPolling(key: string, lease: Lease, callId: string): void {
  const existing = pollers.get(key);
  if (existing && existing.lease === lease) {
    existing.callId = callId;
    existing.until = Date.now() + PROMPT_WINDOW_MS;
    return;
  }
  stopPolling(key);
  const poller: Poller = { lease, callId, until: Date.now() + PROMPT_WINDOW_MS, answered: new Set() };
  pollers.set(key, poller);
  const tick = async () => {
    if (pollers.get(key) !== poller) return;
    if (!isDataOwnerGenerationCurrent(lease.owner)) return stopPolling(key);
    let result: PluginPagePoll | undefined;
    try {
      result = await invokePlugin<PluginPagePoll>(lease.deviceId, lease.pluginId, 'poll', { pageId: lease.pageId, after: 0 });
      lease.usedAt = Date.now();
    } catch {
      if (pollers.get(key) === poller) dropLease(key, lease);
      return;
    }
    if (pollers.get(key) !== poller) return;
    const confirm = result?.confirms?.find((item) => !poller.answered.has(item.id));
    const request = result?.modelPickers?.find((item) => !poller.answered.has(item.requestId));
    const next: RemoteCardPrompt | undefined = confirm
      ? { kind: 'confirm', callId: poller.callId, confirm }
      : request
        ? { kind: 'model', callId: poller.callId, request, remote: { deviceId: lease.deviceId } }
        : undefined;
    const id = (prompt?: RemoteCardPrompt) => prompt?.kind === 'confirm' ? prompt.confirm.id : prompt?.request.requestId;
    if (id(next) !== id(poller.prompt)) {
      poller.prompt = next;
      notifyPrompts();
    }
    const expiresAt = next?.kind === 'confirm' ? next.confirm.expiresAt : next?.request.expiresAt;
    if (expiresAt) poller.until = Math.max(poller.until, expiresAt);
    if (Date.now() >= poller.until) return stopPolling(key);
    poller.timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };
  poller.timer = setTimeout(() => void tick(), POLL_INTERVAL_MS / 2);
}

/** The pending request for a card, if its plugin is waiting for an answer from this window. */
export function getRemoteCardPrompt(callId: string): RemoteCardPrompt | undefined {
  for (const poller of pollers.values()) if (poller.prompt?.callId === callId) return poller.prompt;
  return undefined;
}

const claimedPrompts = new WeakSet<RemoteCardPrompt>();
/** The same card can be shown twice (task page and title bar); only one view answers a request. */
export function claimRemoteCardPrompt(prompt: RemoteCardPrompt): boolean {
  if (claimedPrompts.has(prompt)) return false;
  claimedPrompts.add(prompt);
  return true;
}

export function subscribeRemoteCardPrompts(listener: () => void): () => void {
  promptListeners.add(listener);
  return () => { promptListeners.delete(listener); };
}

function pollerFor(prompt: RemoteCardPrompt): [string, Poller] | undefined {
  for (const entry of pollers) if (entry[1].prompt === prompt) return entry;
  return undefined;
}

function settle(key: string, poller: Poller, answeredId: string): void {
  poller.answered.add(answeredId);
  if (poller.prompt && (poller.prompt.kind === 'confirm' ? poller.prompt.confirm.id : poller.prompt.request.requestId) === answeredId) {
    poller.prompt = undefined;
    notifyPrompts();
  }
  // The answer usually continues the plugin's work, which may ask again.
  if (pollers.get(key) === poller) poller.until = Math.max(poller.until, Date.now() + PROMPT_WINDOW_MS);
}

export async function answerRemoteCardConfirm(prompt: Extract<RemoteCardPrompt, { kind: 'confirm' }>, confirmed: boolean): Promise<boolean> {
  const found = pollerFor(prompt);
  if (!found) return false;
  const [key, poller] = found;
  try {
    await invokePlugin(poller.lease.deviceId, poller.lease.pluginId, 'answer', { pageId: poller.lease.pageId, confirmId: prompt.confirm.id, confirmed });
    settle(key, poller, prompt.confirm.id);
    return true;
  } catch {
    settle(key, poller, prompt.confirm.id);
    return false;
  }
}

/** `route` is relative to this computer; null cancels. Accepted false keeps the menu open for another choice. */
export async function answerRemoteCardModel(
  prompt: Extract<RemoteCardPrompt, { kind: 'model' }>,
  route: GhostCardModelSelection | null,
): Promise<{ handled: boolean; accepted: boolean }> {
  const found = pollerFor(prompt);
  if (!found) return { handled: false, accepted: false };
  const [key, poller] = found;
  const hostRoute = route ? await routeForHost(route, prompt.remote) : null;
  if (route && !hostRoute) return { handled: true, accepted: false };
  try {
    const result = await invokePlugin<{ handled?: boolean; accepted?: boolean }>(poller.lease.deviceId, poller.lease.pluginId, 'answer-model-picker',
      { pageId: poller.lease.pageId, requestId: prompt.request.requestId, route: hostRoute });
    const answer = { handled: result?.handled === true, accepted: result?.accepted === true };
    if (answer.accepted || !answer.handled) settle(key, poller, prompt.request.requestId);
    return answer;
  } catch {
    settle(key, poller, prompt.request.requestId);
    return { handled: false, accepted: false };
  }
}

/** Test only. */
export function __resetGhostCardActionsForTest(): void {
  for (const key of [...pollers.keys()]) stopPolling(key);
  leases.clear();
  promptListeners.clear();
  selfDeviceId = null;
  selfDeviceRead = null;
}
