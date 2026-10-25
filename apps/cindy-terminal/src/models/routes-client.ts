import {
  parseProviderShareReceivedCatalogs,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
} from "@cindy/device-link";
import {
  normalizeModelRoute,
  type ModelRoute,
} from "@cindy/maker-shared/model-route";
import type { TerminalClient } from "../contracts.js";
import { unwrap } from "../client-operations.js";

export type ModelRouteChoice = {
  key: string;
  label: string;
  route: ModelRoute;
  efforts: string[];
  fast: boolean;
  ultrafast: boolean;
};
export const modelRouteKey = (route: ModelRoute) =>
  JSON.stringify([
    route.agentDeviceId ?? "",
    route.harness,
    route.providerId,
    route.model,
  ]);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
export function readModelRouteChain(value: unknown): ModelRoute[] {
  if (typeof value !== "string") throw new Error("INVALID_MODEL_CHAIN");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("INVALID_MODEL_CHAIN");
  }
  if (!Array.isArray(parsed) || parsed.length > 5)
    throw new Error("INVALID_MODEL_CHAIN");
  return parsed.map((value) => {
    if (!["claude", "codex", "pi"].includes(object(value).harness as string))
      throw new Error("INVALID_MODEL_CHAIN");
    const route = normalizeModelRoute(value);
    if (!route) throw new Error("INVALID_MODEL_CHAIN");
    return route;
  });
}

/** Old GUI hosts already expose these catalogs. A terminal editor keeps their
 * opaque settings action and encodes remote routes using the released format. */
export async function readModelRouteChoices(
  client: TerminalClient,
  device?: string,
): Promise<ModelRouteChoice[]> {
  const choices = new Map<string, ModelRouteChoice>();
  const add = (
    raw: unknown,
    name: string,
    agentDeviceId?: string,
    shared = false,
  ) => {
    for (const provider of array(
      Array.isArray(raw) ? raw : object(raw).providers,
    )) {
      if (
        !provider.connected ||
        provider.suspended ||
        (agentDeviceId && !shared && provider.remoteInvocationEnabled !== true)
      )
        continue;
      for (const [agent, models] of Object.entries(object(provider.models))) {
        if (!["claude-code", "codex", "pi"].includes(agent)) continue;
        if (
          provider.id === "anthropic" &&
          provider.source !== "user" &&
          agent !== "claude-code"
        )
          continue;
        for (const model of array(models)) {
          if (
            model.disabled ||
            model.availability === "requires_payment" ||
            typeof model.id !== "string" ||
            typeof provider.id !== "string"
          )
            continue;
          const route: ModelRoute = {
            harness:
              agent === "claude-code" ? "claude" : (agent as "codex" | "pi"),
            providerId: provider.id,
            model: model.id,
            effort: "",
            fastMode: false,
            ...(agentDeviceId ? { agentDeviceId } : {}),
          };
          const key = modelRouteKey(route);
          choices.set(key, {
            key,
            route,
            label: [
              name,
              provider.name ?? provider.id,
              agent,
              model.name ?? model.id,
            ]
              .filter(Boolean)
              .join(" · "),
            efforts: Array.isArray(model.efforts)
              ? model.efforts.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
            fast: model.supportsFastMode === true,
            ultrafast: model.supportsUltrafastMode === true,
          });
        }
      }
    }
  };
  add(unwrap(await client.invoke("maker:provider:list", [], device)), "");
  const extra = await Promise.allSettled([
    client.invoke("terminal:devices:list", []),
    client.invoke("terminal:status", []),
    client.invoke(PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, [], device),
  ]);
  const own =
    extra[1].status === "fulfilled"
      ? object(unwrap(extra[1].value)).deviceId
      : undefined;
  const target = device ?? own;
  const devices =
    extra[0].status === "fulfilled"
      ? array(unwrap(extra[0].value)).filter(
          (row) =>
            row.online &&
            row.deviceId !== target &&
            typeof row.deviceId === "string",
        )
      : [];
  const read = async () => {
    for (;;) {
      const row = devices.shift();
      if (!row) return;
      const id = String(row.deviceId);
      try {
        add(
          unwrap(
            await client.invoke(
              "maker:provider:list",
              [],
              id === own ? undefined : id,
            ),
          ),
          String(row.name ?? id),
          id,
        );
      } catch {
        /* Only this source is unavailable; existing selections remain in the editor. */
      }
    }
  };
  await Promise.all([read(), read()]);
  if (extra[2].status === "fulfilled")
    for (const share of parseProviderShareReceivedCatalogs(
      unwrap(extra[2].value),
    ))
      if (share.status === "active" && share.hostOnline)
        add(
          share.catalog,
          `${share.owner.displayName} · ${share.providerLabel}`,
          share.agentDeviceId,
          true,
        );
  return [...choices.values()];
}
