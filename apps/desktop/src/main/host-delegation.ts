/**
 * Host delegation — run Electron as a client of `cindy-host`.
 *
 * With `CINDY_HOST_API` set, the desktop stops assembling its own runtime and
 * forwards the covered renderer channels to the host's loopback API. Channels
 * outside the allowlist fail loudly instead of silently falling back, so a
 * half-migrated surface is visible rather than pretending to work.
 *
 * The covered set is exactly what the web client already runs end to end:
 * tasks, task messages, providers, agent capabilities, the composer input queue,
 * and the runtime event stream.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { IpcMainInvokeEvent } from 'electron';
import { HOST_CONTRACT_CHANNELS, type HostChannelDef } from '@cindy/maker-shared/host-channel-contract';
import { createIpcError } from '../shared/ipc-errors.js';
import { guardIpcRegistration, type IpcChannelUsage } from './ipcChannelUsage';
import { startHostEventStream, type HostConnectionState } from '@cindy/maker-shared/host-event-stream';

export interface HostDelegationConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly instanceId?: string;
}

/** Env var that enables client mode; the value is the loopback base URL. */
export const HOST_DELEGATION_ENV = 'CINDY_HOST_API';

/**
 * Resolve the delegation target. Returns null when disabled, and throws when
 * enabled but incomplete — a misconfigured client must not boot a second
 * runtime by accident.
 */
export function resolveHostDelegation(input: {
  env: NodeJS.ProcessEnv;
  userDataDir: string;
}): HostDelegationConfig | null {
  const raw = input.env[HOST_DELEGATION_ENV]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${HOST_DELEGATION_ENV} must be an absolute URL (got "${raw}")`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!loopback || url.protocol !== 'http:' || url.username || url.password) {
    throw new Error(`${HOST_DELEGATION_ENV} must point at loopback; the host never listens off-machine`);
  }
  const tokenPath = path.join(input.userDataDir, 'host-api-token');
  let token: string;
  try {
    token = fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    throw new Error(`host delegation requires the profile API token at ${tokenPath}; run cindy-host once first`);
  }
  if (!token) throw new Error('host delegation token is empty');
  const instanceId = input.env.CINDY_HOST_INSTANCE?.trim();
  if (instanceId && !/^[a-zA-Z0-9-]{1,128}$/.test(instanceId)) throw new Error('Invalid Host instance identity');
  return { baseUrl: url.origin, token, ...(instanceId ? { instanceId } : {}) };
}

export interface HostClient {
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export function createHostClient(config: HostDelegationConfig): HostClient {
  return {
    async request(path, body, signal) {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.token}`,
          ...(config.instanceId ? { 'x-cindy-host-instance': config.instanceId } : {}),
        },
        body: JSON.stringify(body ?? null),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text || `host ${path} failed (${response.status})`);
      }
      return text ? JSON.parse(text) : null;
    },
  };
}

interface ProxiedChannel {
  readonly trustedRenderer?: boolean;
  readonly channel: string;
  readonly path: string;
  /** Renderer args → request body. */
  readonly body: (args: unknown[]) => unknown;
  /** Host response → renderer result, when the shapes differ. */
  readonly map?: (response: unknown) => unknown;
}

/** Channels the host implements, derived from shared host-channel-contract. */
export const PROXIED_CHANNELS: readonly ProxiedChannel[] = [
  ...HOST_CONTRACT_CHANNELS.map((def: HostChannelDef) => ({
    channel: def.desktopChannel,
    path: def.hostPath,
    body: def.body ?? (() => null),
    map: def.map,
    trustedRenderer: def.trustedRenderer,
  })),
  {
    // Legacy composer path: enqueue and report acceptance; the answer arrives on
    // the event stream like any other turn.
    channel: 'maker:send',
    path: '/api/input/enqueue',
    body: ([sessionId, message, createOpts]) => {
      const options = createOpts as
        | { agentKind?: string; model?: string; workingDir?: string; effort?: string; permissionMode?: string }
        | undefined;
      const text = typeof message === 'string' ? message : (message as { content?: unknown })?.content;
      return {
        sessionId,
        item: {
          clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
          persistedContent: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
          model: options?.model ?? '',
          effort: options?.effort ?? '',
          permissionMode: options?.permissionMode ?? '',
          workingDir: options?.workingDir ?? '',
        },
      };
    },
    map: () => ({ accepted: true }),
  },
];

/**
 * Keep the host's proxies authoritative: the desktop registers some channels
 * outside the runtime block, and a duplicate `ipcMain.handle` would throw. In
 * client mode those registrations are dropped for proxied channels.
 */
/**
 * Keep the host's proxies authoritative: the desktop registers some channels
 * outside the runtime block, and a duplicate `ipcMain.handle` would throw. In
 * client mode those registrations are dropped for proxied channels.
 *
 * Takes `unknown` so the Electron `IpcMain` type is assignable; the shape is
 * validated by the first call.
 */
export function claimProxiedChannels(
  ipcMain: unknown,
  log: (channel: string) => void,
  /** Channels routed through the Host's generic IPC route (host-ipc-proxy). */
  routed: readonly string[] = [],
): void {
  const target = ipcMain as {
    handle(channel: string, listener: (...args: never[]) => unknown): void;
    __originalHandle?: (channel: string, listener: (...args: never[]) => unknown) => void;
  };
  const proxied = new Set([...PROXIED_CHANNELS.map((entry) => entry.channel), ...routed]);
  const original = target.__originalHandle ?? target.handle.bind(target);
  target.__originalHandle = original;

  target.handle = (
    channel: string,
    listener: (...args: never[]) => unknown,
  ): void => {
    if (proxied.has(channel)) {
      log(channel);
      return;
    }
    original(channel, listener);
  };
}

export interface HostDelegatedIpcDeps {
  readonly assertTrusted?: (event: IpcMainInvokeEvent) => void;
  readonly client: HostClient;
  /** Newly delegated approval paths require the real registered top-level window. */
  readonly authorizePluginApproval?: (event: IpcMainInvokeEvent, channel: string, args: unknown[]) => boolean;
  readonly ipcMain: {
    removeHandler(channel: string): void;
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void;
  };
}

/**
 * Install the proxies. Call after the desktop's own registrations so these
 * replace them: one channel carries one handler.
 */
export function registerHostDelegatedIpc(deps: HostDelegatedIpcDeps): string[] {
  const installed: string[] = [];
  const target = deps.ipcMain as unknown as {
    __originalHandle?: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => void;
    handle: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => void;
    removeHandler(channel: string): void;
  };
  const rawHandle = target.__originalHandle
    ? target.__originalHandle.bind(target)
    : target.handle.bind(target);

  for (const entry of PROXIED_CHANNELS) {
    deps.ipcMain.removeHandler(entry.channel);
    rawHandle(entry.channel, async (event, ...args: unknown[]) => {
      if (entry.trustedRenderer) {
        if (!deps.assertTrusted) throw new Error('Trusted renderer admission is required');
        deps.assertTrusted(event);
      }
      if (['ghosts:request-task-approval', 'ghosts:confirm:resolve', 'ghosts:install-consent:resolve'].includes(entry.channel)
        && deps.authorizePluginApproval?.(event, entry.channel, args) !== true)
        throw createIpcError('PERMISSION_DENIED', 'Host approval requires its trusted owner window.');
      const response = await deps.client.request(entry.path, entry.body(args));
      return entry.map ? entry.map(response) : response;
    });
    installed.push(entry.channel);
  }
  return installed;
}

export interface UnsupportedMakerFallbackDeps {
  readonly ipcMain: unknown;
  readonly channels?: readonly string[];
  /** Called the first time each `maker:*` channel falls back. */
  readonly log?: (channel: string) => void;
  /** Counts every invoke that reaches no handler, ranked later against the channel inventory. */
  readonly usage?: IpcChannelUsage;
}

/**
 * In client mode, any `maker:*` channel outside the proxied contract fails with
 * explicit UNSUPPORTED_CAPABILITY error rather than "No handler registered".
 * Other unhandled channels keep Electron's error and are counted.
 */
export function installUnsupportedMakerFallbacks(deps: UnsupportedMakerFallbackDeps): void {
  const target = deps.ipcMain as {
    _invokeHandlers?: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>;
    handle?: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => void;
    __originalHandle?: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => void;
  };

  const createFallback = (channel: string) => async () => {
    throw createIpcError(
      'UNSUPPORTED_CAPABILITY',
      `Capability ${channel} is not supported in host client mode`,
    );
  };

  if (deps.channels && target.handle) {
    const rawHandle = target.__originalHandle
      ? target.__originalHandle.bind(target)
      : target.handle.bind(target);
    const proxied = new Set(PROXIED_CHANNELS.map((e) => e.channel));
    for (const ch of deps.channels) {
      if (ch.startsWith('maker:') && !proxied.has(ch)) {
        rawHandle(ch, createFallback(ch));
      }
    }
  }

  if (target._invokeHandlers instanceof Map) {
    const handlers = target._invokeHandlers;
    // Electron asks has() before get() on every invoke, and handle() asks has()
    // before it registers. Answer only invokes, so later desktop registrations
    // of a `maker:*` channel still succeed.
    const registering = guardIpcRegistration(target);
    const origHas = handlers.has.bind(handlers);
    const origGet = handlers.get.bind(handlers);
    const fallsBack = (channel: unknown): channel is string =>
      typeof channel === 'string' && channel.startsWith('maker:');
    const logged = new Set<string>();
    handlers.has = (channel: string) => {
      if (origHas(channel)) return true;
      if (registering()) return false;
      if (fallsBack(channel)) return true;
      if (typeof channel === 'string') deps.usage?.record(channel, 'invoke', 'missing');
      return false;
    };
    handlers.get = (channel: string) => {
      const existing = origGet(channel);
      if (existing || registering() || !fallsBack(channel)) return existing;
      if (!logged.has(channel)) {
        logged.add(channel);
        deps.log?.(channel);
      }
      deps.usage?.record(channel, 'invoke', 'unsupported');
      return createFallback(channel);
    };
  }
}

/**
 * The renderer reads the visibility-owner claim **synchronously** at boot, so the
 * host value is fetched once and replayed from memory instead of doing network
 * I/O inside a sendSync handler.
 */
export function registerHostDelegatedSync(input: {
  readonly channel: string;
  readonly path: string;
  readonly client: HostClient;
  /** Host response → the synchronous value the renderer expects. */
  readonly map?: (response: unknown) => unknown;
  readonly ipcMain: { on(channel: string, listener: (event: { returnValue: unknown }) => void): void };
}): Promise<void> {
  return input.client.request(input.path).then((response) => {
    const value = input.map ? input.map(response) : response;
    input.ipcMain.on(input.channel, (event) => {
      event.returnValue = value;
    });
  });
}

/**
 * Relay the host's runtime event stream into every window on the same push
 * channel the embedded runtime uses.
 */
export interface HostEventBridgeInput {
  readonly baseUrl: string;
  readonly token: string;
  readonly instanceId?: string;
  readonly broadcast: (payload: unknown) => void;
  readonly onSettingsChanged?: (domain: string, value: unknown) => void;
  readonly onSessionChanged?: (event: unknown) => void;
  readonly onMessageCreated?: (event: unknown) => void;
  readonly onMessageDeleted?: (event: unknown) => void;
  readonly onErrorPersisted?: (event: unknown) => void;
  readonly onRightSidebarTabsChanged?: (event: unknown) => void;
  readonly onSubagentRunsChanged?: (event: unknown) => void;
  readonly onProjectAliasesChanged?: () => void;
  readonly onInputProjection?: (projection: unknown) => void;
  readonly onInteractionRequest?: (payload: unknown) => void;
  readonly onInteractionDismissed?: (payload: unknown) => void;
  readonly onAuthChanged?: (payload: unknown) => void;
  readonly onPluginPush?: (channel: string, payload: unknown) => void;
  readonly onError?: (error: unknown) => void;
  readonly onConnectionState?: (state: HostConnectionState) => void;
  readonly beforeEvents?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Relay the host's runtime event stream into every window on the same push
 * channel the embedded runtime uses.
 */
export function startHostEventBridge(input: HostEventBridgeInput): (() => void) & { reconnect(): void } {
  const connection = startHostEventStream({
    confirmations: true,
    open: (query, signal) => fetch(`${input.baseUrl}/events${query}`, {
      headers: { authorization: `Bearer ${input.token}`,
        ...(input.instanceId ? { 'x-cindy-host-instance': input.instanceId } : {}) }, signal, redirect: 'error',
    }),
    onState: state => input.onConnectionState?.(state),
    beforeEvents: input.beforeEvents,
    onError: input.onError,
    onEvent: payload => {
      if (payload?.type === 'input_projection') {
        input.onInputProjection?.(payload.projection);
      } else if (payload?.type === 'interaction_request') {
        input.onInteractionRequest?.({ sessionId: payload.sessionId, request: payload.request });
      } else if (payload?.type === 'interaction_dismissed') {
        input.onInteractionDismissed?.({ sessionId: payload.sessionId, requestId: payload.requestId, reason: payload.reason });
      } else if (payload?.type === 'auth_changed') {
        input.onAuthChanged?.(payload);
      } else if (payload?.type === 'plugin_push') {
        input.onPluginPush?.(payload.channel, payload.payload);
      } else if (payload?.type === 'settings_changed') {
        input.onSettingsChanged?.(payload.domain, payload.value);
      } else if (payload?.type === 'appearance_changed') {
        input.onSettingsChanged?.('appearance', payload.appearance);
      } else if (payload?.type === 'session_changed') {
        input.onSessionChanged?.(payload);
      } else if (payload?.type === 'message_created') {
        input.onMessageCreated?.(payload);
      } else if (payload?.type === 'message_deleted') {
        input.onMessageDeleted?.(payload);
      } else if (payload?.type === 'error_persisted') {
        input.onErrorPersisted?.(payload);
      } else if (payload?.type === 'right_sidebar_tabs_changed') {
        input.onRightSidebarTabsChanged?.({ sessionId: payload.sessionId });
      } else if (payload?.type === 'subagent_runs_changed') {
        input.onSubagentRunsChanged?.(payload);
      } else if (payload?.type === 'project_aliases_changed') {
        input.onProjectAliasesChanged?.();
      } else {
        input.broadcast(payload);
      }
    },
  });
  return Object.assign(() => connection.stop(), { reconnect: () => connection.reconnect() });
}
