import { randomUUID } from "node:crypto";
import {
  PLUGIN_SETTINGS_ACTION,
  type PluginOauthAction,
  type PluginSettingsRequest,
} from "@cindy/device-link";
import type { OauthCardBinding } from "@cindy/plugin-runtime/authorization/transactions";
import type { InvocationContext, TerminalClient } from "./contracts.js";
import type { TerminalCapabilities } from "./tasks/capabilities.js";
import type { TerminalFeishuRegistration } from './im/registration.js';
import type { TerminalProviderLogin } from './models/login.js';

// Host-owned settings use the same authenticated exchange as input handoff and
// plugin settings. This identifier cannot be supplied by a plugin or a client.
export const CONFIGURATION_ID = "__cindy_configuration__";
const LIFETIME_MS = 5 * 60_000;
type Operation = {
  collectionId: "mcp" | "providers" | "channels";
  actionId: "create" | "edit" | "connect";
  resourceId?: string;
};
type Lease = {
  operation: Operation;
  context: InvocationContext;
  revision: number;
  expiresAt: number;
  state: "open" | "saving" | "saved" | "failed";
};

export function configurationOperation(raw: unknown): Operation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("INVALID_CONFIGURATION");
  const value = raw as Record<string, unknown>;
  if (
    !["mcp", "providers", "channels"].includes(String(value.collectionId)) ||
    !["create", "edit", "connect"].includes(String(value.actionId)) ||
    (value.resourceId !== undefined &&
      (typeof value.resourceId !== "string" ||
        !value.resourceId ||
        value.resourceId.length > 256)) ||
    (value.actionId === "edit" && !value.resourceId) ||
    (value.actionId === "create" && value.resourceId !== undefined) ||
    (value.collectionId === "channels" && value.actionId !== "edit" && value.actionId !== "connect") ||
    (value.actionId === "connect" && !((value.collectionId === "channels" && value.resourceId === "feishu") || (value.collectionId === "providers" && typeof value.resourceId === 'string' && value.resourceId.length > 0)))
  )
    throw new Error("INVALID_CONFIGURATION");
  return {
    collectionId: value.collectionId as Operation["collectionId"],
    actionId: value.actionId as Operation["actionId"],
    ...(value.resourceId ? { resourceId: value.resourceId as string } : {}),
  };
}

/** A lease authorizes one configuration mutation on one host and controller.
 * No configuration values are included in the generic resource request. */
export class TerminalConfiguration {
  private readonly leases = new Map<string, Lease>();
  private closed = false;
  constructor(
    private readonly capabilities: TerminalCapabilities,
    private readonly providers?: {
      login?: TerminalProviderLogin;
      revision(): number;
      save(
        action: "create" | "edit",
        provider: unknown,
        keys: unknown,
        context: InvocationContext,
      ): Promise<unknown>;
    },
    private readonly channels?: {
      revision(): number;
      save(id: string, value: Record<string, unknown>, context: InvocationContext): Promise<void>;
      registration?: TerminalFeishuRegistration;
    },
  ) {}

  private revision(operation: Operation) {
    if (operation.collectionId === "mcp") return this.capabilities.revision();
    if (operation.collectionId === "channels") {
      if (!this.channels) throw new Error("PROTECTED_CONFIGURATION_UNAVAILABLE");
      return this.channels.revision();
    }
    if (!this.providers) throw new Error("PROTECTED_CONFIGURATION_UNAVAILABLE");
    return this.providers.revision();
  }

  open(raw: unknown, context: InvocationContext) {
    if (this.closed || context.sharedTask) throw new Error("OWNER_REQUIRED");
    context.assertCurrent?.();
    for (const [id, lease] of this.leases)
      if (lease.expiresAt <= Date.now()) this.leases.delete(id);
    if (this.leases.size >= 64) throw new Error("CONFIGURATION_BUSY");
    const operation = configurationOperation(raw),
      id = randomUUID();
    this.leases.set(id, {
      operation,
      context,
      revision: this.revision(operation),
      expiresAt: Date.now() + (operation.collectionId === "providers" && operation.actionId === "connect" ? 20 * 60_000 : LIFETIME_MS),
      state: "open",
    });
    return { id, configurationId: CONFIGURATION_ID };
  }

  private current(lease: Lease) {
    if (this.closed || lease.expiresAt <= Date.now()) return false;
    try {
      this.capabilities.guard();
      lease.context.assertCurrent?.();
    } catch {
      return false;
    }
    return (
      lease.operation.actionId === "connect" ||
      lease.state === "saved" ||
      lease.state === "failed" ||
      lease.revision === this.revision(lease.operation)
    );
  }

  bind(action: PluginOauthAction): OauthCardBinding | null {
    const lease = this.leases.get(action.requestId);
    if (
      !lease ||
      action.actionId !== PLUGIN_SETTINGS_ACTION ||
      action.expectedRevision !== 0 ||
      !this.current(lease)
    )
      return null;
    return {
      ghostId: CONFIGURATION_ID,
      settingsPage: true,
      controllerDeviceId: lease.context.deviceId ?? "terminal-local",
      current: () => this.current(lease),
    };
  }

  owns(id: string) {
    return this.leases.has(id);
  }

  async request(peer: string, request: PluginSettingsRequest) {
    const lease = this.leases.get(request.id);
    if (
      !lease ||
      peer !== (lease.context.deviceId ?? "terminal-local") ||
      !this.current(lease)
    )
      throw new Error("CONFIGURATION_STALE");
    const command = request.command;
    if (command.kind === "close") {
      // The authenticated envelope still needs to seal its final response.
      this.leases.delete(request.id);
      if (lease.operation.actionId === 'connect') {
        if (lease.operation.collectionId === 'providers') this.providers?.login?.cancel(request.id);
        else await this.channels?.registration?.cancel(request.id);
      }
      return { status: 204 };
    }
    if (lease.operation.actionId === 'connect') {
      if (lease.operation.collectionId === 'providers') {
        const login = this.providers?.login;
        if (!login || command.kind !== 'fetch' || command.path !== '/connection') throw new Error('INVALID_CONFIGURATION');
        if (command.method === 'GET') return { status: 200, body: login.read(request.id) };
        if (command.method !== 'POST' || typeof command.body !== 'string') throw new Error('INVALID_CONFIGURATION');
        try {
          const input = JSON.parse(command.body) as { callback?: unknown };
          const body = Object.hasOwn(input, 'callback') ? await login.submit(request.id, input.callback) : login.begin(request.id, lease.operation.resourceId!, () => {
            if (!this.current(lease)) throw new Error('CONFIGURATION_STALE');
          }, lease.expiresAt);
          delete input.callback;
          return { status: 200, body };
        } catch { return { status: 400, code: 'PROVIDER_LOGIN_FAILED' }; }
      }
      const registration = this.channels?.registration;
      if (!registration || command.kind !== 'fetch' || command.path !== '/connection') throw new Error('INVALID_CONFIGURATION');
      if (command.method === 'GET') return { status: 200, body: registration.read(request.id) };
      if (command.method !== 'POST' || typeof command.body !== 'string') throw new Error('INVALID_CONFIGURATION');
      try {
        const input = JSON.parse(command.body) as { service?: unknown };
        const body = await registration.begin(request.id, input?.service, () => {
          if (!this.current(lease)) throw new Error('CONFIGURATION_STALE');
        }, lease.expiresAt);
        return { status: 200, body };
      } catch { return { status: 400, code: 'REGISTRATION_FAILED' }; }
    }
    if (
      command.kind !== "fetch" ||
      command.path !== "/configuration" ||
      command.method !== "PUT" ||
      typeof command.body !== "string" ||
      lease.state !== "open"
    )
      throw new Error("INVALID_CONFIGURATION");
    lease.state = "saving";
    try {
      await this.save(lease.operation, JSON.parse(command.body), {
        ...lease.context,
        assertCurrent: () => {
          if (!this.current(lease)) throw new Error("CONFIGURATION_STALE");
        },
      });
      lease.state = "saved";
      return { status: 204 };
    } catch {
      lease.state = "failed";
      // Never serialize validation failures that might quote submitted values.
      return { status: 400, code: "CONFIGURATION_SAVE_FAILED" };
    }
  }

  async save(operation: Operation, input: unknown, context: InvocationContext) {
    if (this.closed || context.sharedTask) throw new Error("OWNER_REQUIRED");
    if (operation.actionId === 'connect') throw new Error('PROTECTED_INPUT_REQUIRED');
    context.assertCurrent?.();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("INVALID_CONFIGURATION");
    const value = input as Record<string, unknown>;
    if (operation.collectionId === "channels") {
      if (!this.channels || !operation.resourceId) throw new Error("INVALID_CONFIGURATION");
      await this.channels.save(operation.resourceId, value, context);
      return;
    }
    if (operation.collectionId === "providers") {
      if (
        !this.providers ||
        !value.provider ||
        typeof value.provider !== "object" ||
        Array.isArray(value.provider)
      )
        throw new Error("INVALID_CONFIGURATION");
      const provider = value.provider as Record<string, unknown>;
      if (operation.resourceId && provider.id !== operation.resourceId)
        throw new Error("INVALID_CONFIGURATION");
      await this.providers.save(
        operation.actionId,
        provider,
        value.keys ?? {},
        context,
      );
      return;
    }
    const config = {
      ...value,
      ...(operation.resourceId ? { id: operation.resourceId } : {}),
    };
    await this.capabilities.configureMcp(operation.actionId, config, context);
  }

  close() {
    this.closed = true;
    this.leases.clear();
  }
}

export async function submitConfiguration(
  client: TerminalClient,
  operation: Operation,
  input: unknown,
  deviceId?: string,
): Promise<import("@cindy/device-link").RemoteActionInvokeResponse> {
  await client.invoke("terminal:configuration", [
    { ...operation, input, ...(deviceId ? { deviceId } : {}) },
  ]);
  return {
    effects: [
      {
        kind: "refresh-collection" as const,
        collectionId: operation.collectionId,
      },
    ],
  };
}
