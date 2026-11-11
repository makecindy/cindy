import type { Provider, ProviderPreset } from "./types.js";

/** Official connection choices; saved connection names remain user-owned. */
export function mimoPresetName(
  id: string | undefined,
  locale: string,
): string | undefined {
  const regions: Record<string, readonly [string, string, string]> = {
    "xiaomi-mimo-token-plan-cn": ["中国大陆", "中國大陸", "Mainland China"],
    "xiaomi-token-plan-cn": ["中国大陆", "中國大陸", "Mainland China"],
    "xiaomi-token-plan-ams": ["阿姆斯特丹", "阿姆斯特丹", "Amsterdam"],
    "xiaomi-token-plan-sgp": ["新加坡", "新加坡", "Singapore"],
  };
  const region = id && Object.hasOwn(regions, id) ? regions[id] : undefined;
  if (!region && id !== "xiaomi-mimo-api-cn" && id !== "xiaomi")
    return undefined;
  const zh = locale.startsWith("zh");
  const traditional = locale === "zh-tw" || locale.startsWith("zh-hant");
  const brand = zh ? "小米 MiMo" : "Xiaomi MiMo";
  return region
    ? `${brand} Token Plan (${region[zh ? (traditional ? 1 : 0) : 2]})`
    : `${brand} API`;
}

/** Billing identity comes from the official endpoint, never a user-editable name. */
export function isMimoTokenPlanUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      /^token-plan-(cn|ams|sgp)\.xiaomimimo\.com$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isMimoTokenPlanProvider(
  provider: Pick<Provider, "routing" | "models">,
): boolean {
  const routes = Object.values(provider.routing).filter(
    (route) => route !== undefined,
  );
  return (
    routes.length > 0 &&
    routes.every((route) => isMimoTokenPlanUrl(route.upstream)) &&
    Object.values(provider.models).every((models) =>
      (models ?? []).every(
        (model) => !model.route || isMimoTokenPlanUrl(model.route.baseUrl),
      ),
    )
  );
}

export function isMimoTokenPlanPreset(
  preset: Pick<ProviderPreset, "runtimes">,
): boolean {
  const runtimes = Object.values(preset.runtimes).filter(
    (runtime) => runtime !== undefined,
  );
  return (
    runtimes.length > 0 &&
    runtimes.every(
      (runtime) =>
        isMimoTokenPlanUrl(runtime.baseUrl) &&
        runtime.models.every(
          (model) => !model.route || isMimoTokenPlanUrl(model.route.baseUrl),
        ),
    )
  );
}
