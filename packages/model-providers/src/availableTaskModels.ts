import { effectiveSourceIdForModel } from "./registry.js";
import type { ProviderView } from "./registry.js";
import type { ModelRoute as BotModelRoute } from "@cindy/maker-shared/model-route";
export interface AvailableLocalRouteInput {
  providers: readonly ProviderView[];
  providersLoading: boolean;
  availableAgents: ReadonlySet<"cc" | "codex" | "pi">;
  availableAgentsLoaded: boolean;
  preferredRoute?: BotModelRoute | null;
  isModelEnabled?: (
    agent: "claude-code" | "codex" | "pi",
    providerId: string,
    model: { id: string; defaultEnabled?: boolean },
  ) => boolean;
}

/** Validate exactly the requested model; recommendations belong to default
 * selection, never to admission of an explicit task or teammate route. */
export function resolveAvailableLocalRoute(
  args: AvailableLocalRouteInput,
): BotModelRoute | null {
  const preferred = args.preferredRoute;
  // Remote routes are validated against their own authorized catalog below.
  if (
    !preferred ||
    preferred.agentDeviceId ||
    args.providersLoading ||
    !args.availableAgentsLoaded
  )
    return null;
  const agent =
    preferred.harness === "claude" ? "claude-code" : preferred.harness;
  if (!args.availableAgents.has(agent === "claude-code" ? "cc" : agent))
    return null;
  const providers = args.providers
    .filter((p) => p.connected && !p.suspended && !p.modelDiscoveryFailure)
    .map((p) => ({
      ...p,
      models: {
        ...p.models,
        [agent]: (p.models[agent] ?? []).filter(
          (m) =>
            args.isModelEnabled?.(agent, p.id, m) ?? m.defaultEnabled !== false,
        ),
      },
    }));
  const providerId = effectiveSourceIdForModel(
    providers,
    preferred.providerId,
    preferred.model,
    agent,
  );
  return providerId ? { ...preferred, providerId } : null;
}

export function availableAppDefaultModels(input: {
  providers: readonly ProviderView[];
  currentRoute?: BotModelRoute | null;
  tuning?: (
    agent: "claude-code" | "codex" | "pi",
    providerId: string,
    model: string,
  ) => { effort?: string; fastMode?: boolean | "ultrafast" };
  availableAgents: ReadonlySet<"cc" | "codex" | "pi">;
  enabled: NonNullable<
    Parameters<typeof resolveAvailableLocalRoute>[0]["isModelEnabled"]
  >;
}) {
  const current = resolveAvailableLocalRoute({
    providers: input.providers,
    providersLoading: false,
    availableAgents: input.availableAgents,
    availableAgentsLoaded: true,
    preferredRoute: input.currentRoute ?? undefined,
    isModelEnabled: input.enabled,
  });
  return input.providers.flatMap((provider) =>
    (["claude-code", "codex", "pi"] as const).flatMap((agent) =>
      (provider.models[agent] ?? []).flatMap((model) => {
        const remembered = input.tuning?.(agent, provider.id, model.id);
        const route: BotModelRoute = {
          harness: agent === "claude-code" ? "claude" : agent,
          providerId: provider.id,
          model: model.id,
          effort:
            model.defaultEffort && model.efforts.includes(model.defaultEffort)
              ? model.defaultEffort
              : "",
          fastMode: false,
        };
        if (
          current &&
          current.harness === route.harness &&
          current.providerId === route.providerId &&
          current.model === route.model
        ) {
          if (model.efforts.some((effort) => effort === current.effort))
            route.effort = current.effort;
          route.fastMode = model.supportsFastMode === true && current.fastMode;
        }
        // The picker preference is authoritative for a remembered target, including false Fast.
        if (remembered?.effort !== undefined)
          route.effort = model.efforts.some(
            (effort) => effort === remembered.effort,
          )
            ? remembered.effort
            : model.defaultEffort && model.efforts.includes(model.defaultEffort)
              ? model.defaultEffort
              : "";
        if (remembered?.fastMode !== undefined)
          route.fastMode =
            model.supportsFastMode === true && remembered.fastMode;
        const valid = resolveAvailableLocalRoute({
          providers: input.providers,
          providersLoading: false,
          availableAgents: input.availableAgents,
          availableAgentsLoaded: true,
          preferredRoute: route,
          isModelEnabled: input.enabled,
        });
        return valid
          ? [
              {
                id: JSON.stringify([
                  route.harness,
                  route.providerId,
                  route.model,
                ]),
                route,
                efforts: model.efforts,
                supportsFastMode: model.supportsFastMode === true,
                supportsUltrafastMode:
                  agent === "codex" && model.supportsUltrafastMode === true,
              },
            ]
          : [];
      }),
    ),
  );
}
