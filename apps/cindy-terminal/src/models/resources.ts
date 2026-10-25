import type { RemoteResourceRegistry } from "@cindy/device-link";
import type { InvocationContext } from "../contracts.js";
import type { TerminalConfiguration } from "../configuration.js";
import type { TerminalModelConfig } from "./config.js";

type Invoke = (
  channel: string,
  args: unknown[],
  context: InvocationContext,
) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_ARGUMENT");
  return value as Record<string, unknown>;
};

/** Owner-scoped settings operations with no generic secret-bearing IPC. Tests
 * and discovery always use the saved route and vault on the selected host. */
export function registerModelConfigurationResources(
  registry: RemoteResourceRegistry,
  models: TerminalModelConfig,
  configuration: TerminalConfiguration,
  invoke: Invoke,
) {
  const items = () =>
    models.snapshot().providers.map((provider) => ({
      ref: { collectionId: "providers", kind: "provider", id: provider.id },
      revision: String(models.revision()),
      display: { title: provider.name },
      links: [],
    }));
  registry.register({
    collection: {
      id: "providers",
      resourceKind: "provider",
      title: {
        fallback: "Providers",
        translations: {
          en: "Providers",
          "zh-CN": "供应商",
          "zh-TW": "供應商",
          ja: "プロバイダー",
          ko: "공급자",
        },
      },
      placement: "settings",
    },
    list: async () => ({
      collectionId: "providers",
      revision: String(models.revision()),
      items: items(),
    }),
    get: async (_context, request) => {
      const item = items().find((item) => item.ref.id === request.ref.id);
      if (!item) throw new Error("PROVIDER_NOT_FOUND");
      return item;
    },
    invoke: async (context, request) => {
      context.assertCurrent?.();
      const input = object(request.input ?? {});
      const owner: InvocationContext = {
        source: "local",
        deviceId: context.controllerDeviceId,
        assertCurrent: context.assertCurrent,
      };
      if (request.actionId === "configuration:open")
        return {
          effects: [],
          result: configuration.open(
            {
              collectionId: "providers",
              actionId: input.actionId,
              ...(request.resourceRef
                ? { resourceId: request.resourceRef.id }
                : {}),
            },
            owner,
          ),
        };
      if (request.actionId === "create" || request.actionId === "edit")
        throw new Error("PROTECTED_INPUT_REQUIRED");
      if (request.actionId === "configuration:read")
        return {
          effects: [],
          result: { ...models.snapshot(), presets: models.presets() },
        };
      const result = await performModelConfigurationAction(
        models,
        invoke,
        request.actionId,
        input,
        owner,
      );
      context.assertCurrent?.();
      return {
        effects: [{ kind: "refresh-collection", collectionId: "providers" }],
        result,
      };
    },
  });
}

export async function performModelConfigurationAction(
  models: Pick<TerminalModelConfig, "snapshot">,
  invoke: Invoke,
  action: string,
  input: Record<string, unknown>,
  context: InvocationContext,
) {
  if (action === 'context:get') {
    const result = object(await invoke('maker:model-context-limit:get', [input.target], context));
    return {...result, owner: await invoke('terminal:models:context-owner', [], context)};
  }
  if (action === 'context:set' || action === 'context:reset') {
    return invoke(action === 'context:set' ? 'maker:model-context-limit:set' : 'maker:model-context-limit:reset',
      action === 'context:set' ? [input.target, input.limit, input.owner] : [input.target, input.owner], context);
  }
  if (action === "disabled")
    return invoke("maker:model-disable:set", [input], context);
  const id = input.providerId;
  if (typeof id !== "string" || !id) throw new Error("PROVIDER_REQUIRED");
  const simple: Record<string, string> = {
    remove: "maker:provider:custom:delete",
    disconnect: "maker:provider:custom:disconnect",
    refresh: "maker:provider:models-refresh",
  };
  if (simple[action]) return invoke(simple[action], [id], context);
  if (action !== "test" && action !== "discover")
    throw new Error("INVALID_ACTION");
  const provider = models
    .snapshot()
    .providers.find((provider) => provider.id === id);
  if (!provider) throw new Error("PROVIDER_NOT_FOUND");
  const agent = input.agentKind;
  if (agent !== "pi" && agent !== "codex" && agent !== "claude-code")
    throw new Error("INVALID_ENGINE");
  const runtime = provider.runtimes[agent];
  if (!runtime) throw new Error("PROVIDER_RUNTIME_REQUIRED");
  return action === "test"
    ? invoke(
        "maker:provider:test-connection",
        [{ kind: "saved", agent, providerId: id }],
        context,
      )
    : invoke(
        "maker:provider:models-fetch",
        [
          {
            agent,
            baseUrl: runtime.baseUrl,
            wireProtocol: runtime.wireProtocol,
            authMethod: provider.auth?.method ?? "apiKey",
            savedProviderId: id,
          },
        ],
        context,
      );
}
