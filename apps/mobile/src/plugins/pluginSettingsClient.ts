import {
  PLUGIN_PAGE_MAX_BUNDLE_BYTES,
  PLUGIN_SETTINGS_ACTION,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  parsePluginSettingsRequest,
  parsePluginOauthAction,
  oauthId,
  oauthGhostId,
  type PluginOauthAction,
  type PluginOauthRequest,
  type PluginPageFile,
  type PluginSettingsCommand,
} from "@cindy/device-link";
import { pluginSettingsMediaType } from "./pluginSettingsAssets";

export interface PluginSettingsIdentity {
  deviceId: string;
  instanceId: string;
  expectedInstalledApproval: string;
}
export interface PluginSettingsDocument {
  pageId: string;
  pluginId: string;
  manifestId: string;
  name: string;
  entry: string;
  files: PluginPageFile[];
  controllerAuthorization?: true;
  documentIsolation?: true;
}
export interface PluginSettingsSession {
  request(request: PluginOauthRequest): Promise<unknown>;
  dispose(): void;
}
export interface PluginSettingsClientOptions {
  identity: PluginSettingsIdentity;
  /** Returns the direct mobile RemoteInvoke result, not a Desktop {ok,result} envelope. */
  invokeTarget(channel: string, args: unknown[]): Promise<unknown>;
  /** Use openMobilePluginOauthSession with this exact target and captured owner/connection. */
  openSession(action: PluginOauthAction): Promise<PluginSettingsSession>;
  assertCurrent(): void;
  /** Owner/connection guard only, so a hidden/closed document can release its own old lease. */
  assertCleanupCurrent?(): void;
  /** Trusted native browser/device-code flow. The Host still exchanges tokens and saves them. */
  onAuthorize?(action: PluginOauthAction): Promise<void>;
  now?(): number;
}
const unavailable = () => new Error("PLUGIN_SETTINGS_UNAVAILABLE");
const safePath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length <= 256 &&
  path
    .split("/")
    .every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/.test(part));

export function parsePluginSettingsDocument(
  raw: unknown,
  instanceId: string,
): PluginSettingsDocument {
  const doc = raw as PluginSettingsDocument;
  if (
    !doc ||
    !oauthId(doc.pageId) ||
    doc.pluginId !== instanceId ||
    !oauthId(doc.manifestId) ||
    typeof doc.name !== "string" ||
    doc.name.length > 160 ||
    !safePath(doc.entry) ||
    !Array.isArray(doc.files) ||
    !doc.files.length ||
    doc.files.length > 10_000
  )
    throw unavailable();
  let total = 0;
  const paths = new Set<string>();
  for (const file of doc.files) {
    if (
      !file ||
      !safePath(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.mime !== "string" ||
      !pluginSettingsMediaType(file.mime)
    )
      throw unavailable();
    paths.add(file.path);
    total += file.size;
  }
  if (
    total > PLUGIN_PAGE_MAX_BUNDLE_BYTES ||
    !doc.files.some(
      (file) =>
        file.path === doc.entry &&
        pluginSettingsMediaType(file.mime) === "text/html",
    )
  )
    throw unavailable();
  // Copy the Host declaration so callers cannot change the asset/instance binding later.
  return {
    pageId: doc.pageId,
    pluginId: doc.pluginId,
    manifestId: doc.manifestId,
    name: doc.name,
    entry: doc.entry,
    files: doc.files.map((file) => ({ ...file })),
    ...(doc.documentIsolation === true ? { documentIsolation: true as const } : {}),
    ...(doc.controllerAuthorization === true ? { controllerAuthorization: true as const } : {}),
  };
}

/** Same endpoint boundary as the target's original settings executor, never a general HTTP proxy. */
export function isPluginSettingsFetch(path: string, method: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const url = new URL(path, "https://plugin.invalid");
  if (url.origin !== "https://plugin.invalid" || url.hash) return false;
  if (method === "GET" && url.pathname.startsWith("/secrets/")) return false;
  if (/^\/secrets\/[a-z][a-z0-9_]{0,31}\/check$/.test(url.pathname)) return method === "POST";
  return (
    ["GET", "PUT", "POST", "DELETE"].includes(method) &&
    /^\/(?:kv|app-context|agent-models|media-models|secrets(?:\/[^/]+)?|oauth(?:\/[^/]+\/(?:client|default|insufficient-scopes|accounts\/[^/]+|connect))?|connections(?:\/[^/]+(?:\/[^/]+)?)?|wake)$/.test(
      url.pathname,
    )
  );
}

/** One original settings lease. Commands are never retried after a possibly committed request. */
export async function openPluginSettingsClient(
  options: PluginSettingsClientOptions,
) {
  const identity = { ...options.identity };
  if (
    !oauthId(identity.deviceId) ||
    !oauthGhostId(identity.instanceId) ||
    typeof identity.expectedInstalledApproval !== "string" ||
    identity.expectedInstalledApproval.length > 4096
  )
    throw unavailable();
  const now = options.now ?? Date.now;
  let closed = false;
  const current = () => {
    if (closed) throw unavailable();
    options.assertCurrent();
  };
  current();
  const response = await options.invokeTarget(REMOTE_RESOURCE_INVOKE_CHANNEL, [
    {
      client: {
        protocolVersion: 1,
        primitives: ["status", "markdown", "action", "form", "list"],
      },
      collectionId: "plugins",
      actionId: "settings:open",
      resourceRef: {
        collectionId: "plugins",
        kind: "plugin",
        id: identity.instanceId,
      },
      input: { expectedInstalledApproval: identity.expectedInstalledApproval },
    },
  ]);
  current();
  const document = parsePluginSettingsDocument(
    (response as { result?: unknown })?.result,
    identity.instanceId,
  );
  type Exchange = {
    session: PluginSettingsSession;
    pending: number;
    retired: boolean;
  };
  const sessions = new Set<Exchange>();
  let exchange: Exchange | undefined;
  let renewing: Promise<void> | undefined;
  let renewedAt = 0,
    sent = 0;
  const connect = async () => {
    current();
    const next = await options.openSession({
      requestId: document.pageId,
      actionId: PLUGIN_SETTINGS_ACTION,
      expectedRevision: 0,
    });
    try {
      current();
    } catch (error) {
      next.dispose();
      throw error;
    }
    const prior = exchange;
    exchange = { session: next, pending: 0, retired: false };
    sessions.add(exchange);
    if (prior) {
      prior.retired = true;
      if (!prior.pending) {
        prior.session.dispose();
        sessions.delete(prior);
      }
    }
    renewedAt = now();
    sent = 0;
  };
  const send = async (command: PluginSettingsCommand): Promise<unknown> => {
    current();
    if (
      !parsePluginSettingsRequest({
        op: "settings",
        id: document.pageId,
        command,
      })
    )
      throw unavailable();
    while (!exchange || now() - renewedAt >= 240_000 || sent >= 1000) {
      renewing ??= connect().finally(() => {
        renewing = undefined;
      });
      await renewing;
      current();
    }
    current();
    sent++;
    const active = exchange!;
    active.pending++;
    try {
      const result = await active.session.request({
        op: "settings",
        id: document.pageId,
        command,
      });
      current();
      return result;
    } catch (error) {
      // Only a mutation handed to the encrypted transport can have an unknown result.
      const mutation =
        (command.kind === "fetch" && command.method !== "GET") ||
        command.kind === "post" ||
        command.kind === "authorize";
      if (mutation)
        throw Object.assign(error instanceof Error ? error : unavailable(), {
          settingsOutcome: "unknown" as const,
        });
      throw error;
    } finally {
      active.pending--;
      if (active.retired && !active.pending && sessions.delete(active))
        active.session.dispose();
    }
  };
  try {
    await connect();
  } catch (error) {
    closed = true;
    throw error;
  }
  return {
    document,
    assertCurrent: current,
    async fetch(path: string, method = "GET", body?: string) {
      if (!isPluginSettingsFetch(path, method))
        throw new Error("PLUGIN_SETTINGS_ENDPOINT_BLOCKED");
      if (/^\/oauth\/[^/]+\/connect$/.test(path) && method === "POST") {
        if (!options.onAuthorize)
          throw new Error("PLUGIN_SETTINGS_AUTHORIZATION_UNAVAILABLE");
        current();
        if (document.controllerAuthorization !== true)
          throw new Error("PLUGIN_SETTINGS_HOST_UPDATE_REQUIRED");
        const action = parsePluginOauthAction(
          await send({
            kind: "authorize",
            path,
            ...(body === undefined ? {} : { body }),
          }),
        );
        body = undefined;
        if (!action) throw unavailable();
        let failure: unknown;
        try {
          await options.onAuthorize(action);
        } catch (error) {
          failure = error;
        }
        current();
        try {
          return await send({
            kind: "authorization-result",
            requestId: action.requestId,
          });
        } catch (error) {
          throw failure ?? error;
        }
      }
      return send({
        kind: "fetch",
        path,
        method,
        ...(body === undefined ? {} : { body }),
      });
    },
    /** Only trusted native callers may answer prompts or read package assets. */
    send,
    async close() {
      if (closed) return;
      // Start best-effort lease cleanup before closing the local guard. Never reauthenticate to close.
      let cleanup: Promise<unknown> | undefined;
      try {
        (options.assertCleanupCurrent ?? options.assertCurrent)();
        if (exchange)
          cleanup = exchange.session.request({
            op: "settings",
            id: document.pageId,
            command: { kind: "close" },
          });
      } catch {
        /* Owner/connection changes already revoke the Host lease. */
      }
      closed = true;
      try {
        await cleanup;
      } catch {
        /* Expiry is the fallback; a lost close is never replayed. */
      } finally {
        for (const exchange of sessions) exchange.session.dispose();
        sessions.clear();
      }
    },
  };
}
export type PluginSettingsClient = Awaited<
  ReturnType<typeof openPluginSettingsClient>
>;
