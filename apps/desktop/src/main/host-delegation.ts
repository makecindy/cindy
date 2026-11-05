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

export interface HostDelegationConfig {
  readonly baseUrl: string;
  readonly token: string;
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
  if (!loopback) {
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
  return { baseUrl: url.origin, token };
}

export interface HostClient {
  request(path: string, body?: unknown): Promise<unknown>;
}

export function createHostClient(config: HostDelegationConfig): HostClient {
  return {
    async request(path, body) {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.token}`,
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
  readonly channel: string;
  readonly path: string;
  /** Renderer args → request body. */
  readonly body: (args: unknown[]) => unknown;
  /** Host response → renderer result, when the shapes differ. */
  readonly map?: (response: unknown) => unknown;
}

/** Channels the host implements; everything else is intentionally absent. */
export const PROXIED_CHANNELS: readonly ProxiedChannel[] = [
  { channel: 'local-db:sessions:list', path: '/api/sessions/list', body: () => null },
  {
    channel: 'local-db:sessions:get',
    path: '/api/sessions/get',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    channel: 'local-db:sessions:create',
    path: '/api/sessions/create',
    body: ([body]) => body ?? {},
  },
  {
    channel: 'local-db:messages:estimated-value',
    path: '/api/messages/estimated-value',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    channel: 'maker:input:remove',
    path: '/api/input/remove',
    body: ([sessionId, clientId]) => ({ sessionId, clientId }),
  },
  {
    channel: 'model-access:get-status',
    path: '/api/model-access',
    body: () => null,
  },
  {
    channel: 'local-db:messages:list',
    path: '/api/messages/list',
    body: ([sessionId, opts]) => ({
      sessionId,
      limit: (opts as { limit?: number } | undefined)?.limit,
    }),
  },
  {
    channel: 'local-db:messages:view',
    path: '/api/messages/history-view',
    body: ([sessionId, opts]) => ({
      sessionId,
      before: (opts as { before?: string | null } | undefined)?.before ?? null,
    }),
  },
  {
    channel: 'local-db:messages:create',
    path: '/api/messages/create',
    body: ([sessionId, message]) => ({ sessionId, message }),
  },
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
  {
    channel: 'maker:list-active',
    path: '/api/sessions/list',
    body: () => null,
  },
  { channel: 'maker:provider:list', path: '/api/providers', body: () => null },
  {
    channel: 'maker:get-capabilities',
    path: '/api/capabilities',
    body: ([agentKind]) => ({ agentKind }),
  },
  {
    channel: 'maker:input:get-projection',
    path: '/api/input/projection',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    channel: 'maker:input:enqueue',
    path: '/api/input/enqueue',
    body: ([sessionId, item]) => ({ sessionId, item }),
  },
  {
    channel: 'maker:input:stop',
    path: '/api/input/stop',
    body: ([sessionId]) => ({ sessionId }),
  },
  {
    channel: 'maker:input:steer',
    path: '/api/input/steer',
    body: ([sessionId, item]) => ({ sessionId, item }),
  },
  {
    channel: 'maker:input:resume',
    path: '/api/input/resume',
    body: ([sessionId]) => ({ sessionId }),
  },
];

export interface HostDelegatedIpcDeps {
  readonly client: HostClient;
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
  for (const entry of PROXIED_CHANNELS) {
    deps.ipcMain.removeHandler(entry.channel);
    deps.ipcMain.handle(entry.channel, async (_event, ...args: unknown[]) => {
      const response = await deps.client.request(entry.path, entry.body(args));
      return entry.map ? entry.map(response) : response;
    });
    installed.push(entry.channel);
  }
  return installed;
}

/**
 * Relay the host's runtime event stream into every window on the same push
 * channel the embedded runtime uses.
 */
export function startHostEventBridge(input: {
  baseUrl: string;
  token: string;
  broadcast: (payload: unknown) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let stopped = false;
  const abort = new AbortController();

  void (async () => {
    while (!stopped) {
      try {
        const response = await fetch(`${input.baseUrl}/events`, {
          headers: { authorization: `Bearer ${input.token}` },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
            if (!line) continue;
            try {
              input.broadcast(JSON.parse(line.slice(6)));
            } catch {
              // Keep the stream alive on a malformed frame.
            }
          }
        }
      } catch (error) {
        if (!stopped) input.onError?.(error);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();

  return () => {
    stopped = true;
    abort.abort();
  };
}
