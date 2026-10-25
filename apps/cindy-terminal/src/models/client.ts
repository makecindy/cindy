import type { TerminalClient } from "../contracts.js";
import { unwrap } from "../client-operations.js";
import { submitConfiguration } from "../configuration.js";
import { performModelConfigurationAction } from "./resources.js";
import type { TerminalModelConfig } from "./config.js";

const descriptor = {
  protocolVersion: 1,
  primitives: ["text", "actions"],
} as const;
async function remote(
  client: TerminalClient,
  device: string,
  actionId: string,
  input: Record<string, unknown> = {},
) {
  const response = unwrap(
    await client.invoke(
      "maker:remote-resources:invoke",
      [{ client: descriptor, collectionId: "providers", actionId, input }],
      device,
    ),
  ) as { result?: unknown };
  return unwrap(response.result);
}
export async function readModelConfiguration(
  client: TerminalClient,
  device?: string,
): Promise<
  ReturnType<TerminalModelConfig["snapshot"]> & {
    presets: ReturnType<TerminalModelConfig["presets"]>;
  }
> {
  if (device)
    return (await remote(client, device, "configuration:read")) as Awaited<
      ReturnType<typeof readModelConfiguration>
    >;
  const state = unwrap(
    await client.invoke("terminal:models:get", []),
  ) as ReturnType<TerminalModelConfig["snapshot"]>;
  const presets = unwrap(await client.invoke("maker:provider:presets", [])) as {
    presets: ReturnType<TerminalModelConfig["presets"]>;
  };
  return { ...state, presets: presets.presets };
}
export async function saveModelProvider(
  client: TerminalClient,
  provider: Record<string, unknown>,
  keys: Record<string, string>,
  edit: boolean,
  device?: string,
) {
  return submitConfiguration(
    client,
    {
      collectionId: "providers",
      actionId: edit ? "edit" : "create",
      ...(edit ? { resourceId: String(provider.id) } : {}),
    },
    { provider, keys },
    device,
  );
}
export async function invokeModelConfiguration(
  client: TerminalClient,
  action: string,
  input: Record<string, unknown>,
  device?: string,
) {
  if (device) return remote(client, device, action, input);
  const state = await readModelConfiguration(client);
  return unwrap(
    await performModelConfigurationAction(
      { snapshot: () => state },
      async (channel, args) => unwrap(await client.invoke(channel, args)),
      action,
      input,
      { source: "local" },
    ),
  );
}
