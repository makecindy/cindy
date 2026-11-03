import type { ModelCatalogEntry as ModelAccessGatewayModel } from "./modelAccessBean.js";
import { parseListModelsResponse } from "./modelAccessValidator.js";

export const BYOK_PROVIDERS_PATH =
  "/api/model-access/byok/providers?schemaVersion=1";
export const BYOK_CREDENTIALS_PATH =
  "/api/model-access/byok/credentials?schemaVersion=1";

export type ByokWireProtocol =
  "anthropic-messages" | "openai-responses" | "openai-completions";
export type ByokNativeApi = ByokWireProtocol | "openai-images";
export const BYOK_IMAGE_MODE = "image_generation";
export function isByokImageMode(mode: unknown): mode is typeof BYOK_IMAGE_MODE {
  return mode === BYOK_IMAGE_MODE;
}
export function isByokSupportedMode(mode: unknown): boolean {
  return mode === undefined || mode === "chat" || isByokImageMode(mode);
}
type ModelOverride = NonNullable<ModelAccessGatewayModel["perAgent"]>["pi"];
export type ByokModel = Omit<ModelAccessGatewayModel, "perAgent"> & {
  nativeApi?: ByokNativeApi;
  perAgent: Partial<
    Record<
      "claude-code" | "codex" | "pi",
      Omit<NonNullable<ModelOverride>, "wireProtocol"> & {
        wireProtocol: ByokWireProtocol;
      }
    >
  >;
};

export interface ByokProvider {
  id: string;
  name: string;
  connectionRevision: number;
  models: ByokModel[];
  imageBinding?: {
    enabled: true;
    modelId: string;
    name?: string;
    supportsEdit: boolean;
    wireModel: string;
    litellmModel: string;
  };
}
export interface ByokProvidersResponse {
  schemaVersion: 1;
  organizationId: string;
  revision: string;
  providers: ByokProvider[];
}
export type ByokCredential =
  | {
      providerId: string;
      connectionRevision: number;
      status: "ready";
      endpoint: string;
      apiKey: string;
    }
  | { providerId: string; connectionRevision: number; status: "pending" }
  | {
      providerId: string;
      connectionRevision: number;
      status: "error";
      code: "UNAVAILABLE" | "REVOKED";
    };
/** Main-process HTTP payload. Never publish this object through IPC or a catalog. */
export interface ByokCredentialsResponse {
  schemaVersion: 1;
  organizationId: string;
  credentials: ByokCredential[];
}
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Parsed<never> => ({ ok: false, error });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 191): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const isByokProviderId = (value: unknown): value is string =>
  typeof value === "string" && /^byok-[a-z0-9][a-z0-9-]{0,185}$/.test(value);
const fields = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

function envelope(
  value: unknown,
): value is Record<string, unknown> & { organizationId: string } {
  return (
    record(value) && value.schemaVersion === 1 && text(value.organizationId)
  );
}

export function parseByokProvidersResponse(
  value: unknown,
): Parsed<ByokProvidersResponse> {
  if (
    !envelope(value) ||
    !fields(value, [
      "schemaVersion",
      "organizationId",
      "revision",
      "providers",
    ]) ||
    !text(value.revision, 256) ||
    !Array.isArray(value.providers) ||
    value.providers.length > 100
  ) {
    return fail("Invalid BYOK provider directory");
  }
  const ids = new Set<string>();
  const providers: ByokProvider[] = [];
  for (const item of value.providers) {
    if (
      !record(item) ||
      !fields(item, [
        "id",
        "name",
        "connectionRevision",
        "models",
        "imageBinding",
      ]) ||
      !isByokProviderId(item.id) ||
      ids.has(item.id) ||
      !text(item.name, 128) ||
      !revision(item.connectionRevision) ||
      !Array.isArray(item.models) ||
      item.models.length === 0 ||
      item.models.length > 2000
    ) {
      return fail("Invalid or duplicate BYOK provider");
    }
    const modelInputs = item.models;
    const transports = new Map<string, ByokWireProtocol>();
    const nativeApis = new Map<string, ByokNativeApi>();
    const modelIds = new Set<string>();
    for (const model of modelInputs) {
      if (!record(model) || !Array.isArray(model.agents)) {
        return fail("BYOK chat models require explicit engine protocols");
      }
      const modelIdLimit =
        typeof model.id === "string" && model.id.startsWith(`${item.id}/`)
          ? 448
          : 256;
      if (
        !text(model.id, modelIdLimit) ||
        modelIds.has(model.id) ||
        model.id.includes("*")
      )
        return fail("Invalid or duplicate BYOK model ID");
      modelIds.add(model.id);
      if (!isByokSupportedMode(model.mode))
        return fail("BYOK only supports chat and image_generation models");
      if (isByokImageMode(model.mode)) {
        if (model.agents.length !== 0)
          return fail("BYOK image models must not declare chat engines");
        if (
          model.perAgent !== undefined &&
          (!record(model.perAgent) || Object.keys(model.perAgent).length !== 0)
        ) {
          return fail("BYOK image models must not declare engine protocols");
        }
        if (model.nativeApi !== undefined) {
          if (model.nativeApi !== "openai-images")
            return fail("Invalid BYOK image native protocol");
          nativeApis.set(model.id, "openai-images");
        }
        continue;
      }
      if (model.agents.length === 0 || !record(model.perAgent)) {
        return fail("BYOK chat models require explicit engine protocols");
      }
      if (model.nativeApi !== undefined) {
        if (
          ![
            "anthropic-messages",
            "openai-responses",
            "openai-completions",
          ].includes(String(model.nativeApi))
        )
          return fail("Invalid BYOK native protocol");
        nativeApis.set(model.id, model.nativeApi as ByokWireProtocol);
      }
      for (const agent of model.agents) {
        if (typeof agent !== "string" || !record(model.perAgent[agent]))
          return fail("Invalid BYOK engine");
        const protocol = (model.perAgent[agent] as Record<string, unknown>)
          .wireProtocol;
        const supported =
          agent === "pi"
            ? ["anthropic-messages", "openai-responses", "openai-completions"]
            : agent === "claude-code"
              ? ["anthropic-messages"]
              : agent === "codex"
                ? ["openai-responses"]
                : [];
        if (typeof protocol !== "string" || !supported.includes(protocol))
          return fail("Unsupported BYOK engine protocol");
        if (typeof model.id === "string")
          transports.set(agent + ":" + model.id, protocol as ByokWireProtocol);
      }
    }
    // Reuse legacy metadata validation without changing its fixed Pi transport contract.
    // Restore the independently validated BYOK protocol after parsing.
    const models = parseListModelsResponse({
      schemaVersion: 4,
      models: modelInputs.map((value, index) => {
        const model = value as Record<string, unknown>;
        const perAgent = record(model.perAgent) ? model.perAgent : {};
        const { nativeApi: _nativeApi, ...metadata } = model;
        // The shared catalog contract caps ids at 256 characters. BYOK ids may contain both a
        // provider namespace and a full upstream id, so validate that id above and use a local
        // surrogate while reusing the shared metadata validator.
        return {
          ...metadata,
          id: `byok-model-${index}`,
          perAgent: {
            ...perAgent,
            ...(perAgent.pi
              ? {
                  pi: {
                    ...(perAgent.pi as Record<string, unknown>),
                    wireProtocol: "openai-responses",
                  },
                }
              : {}),
          },
        };
      }),
    });
    if (!models.ok) return fail("Invalid BYOK model metadata");
    ids.add(item.id);
    const parsedModels: ByokModel[] = models.value.models.map(
      (model, index) => {
        const modelId = (modelInputs[index] as Record<string, unknown>)
          .id as string;
        const perAgent: ByokModel["perAgent"] = {};
        for (const agent of ["claude-code", "codex", "pi"] as const) {
          const override = model.perAgent?.[agent];
          const wireProtocol = transports.get(agent + ":" + modelId);
          if (override && wireProtocol)
            perAgent[agent] = { ...override, wireProtocol };
        }
        return {
          ...model,
          id: modelId,
          ...(nativeApis.has(modelId)
            ? { nativeApi: nativeApis.get(modelId)! }
            : {}),
          perAgent,
        };
      },
    );
    let imageBinding: ByokProvider["imageBinding"];
    if (item.imageBinding !== undefined) {
      const binding = item.imageBinding as Record<string, unknown>;
      if (
        !record(binding) ||
        !fields(binding, [
          "enabled",
          "modelId",
          "name",
          "supportsEdit",
          "wireModel",
          "litellmModel",
        ]) ||
        binding.enabled !== true ||
        !text(binding.modelId, 256) ||
        !text(binding.wireModel, 256) ||
        !text(binding.litellmModel, 448) ||
        typeof binding.supportsEdit !== "boolean" ||
        (binding.name !== undefined && !text(binding.name, 128))
      )
        return fail("Invalid BYOK image binding");
      imageBinding = {
        enabled: true,
        modelId: binding.modelId,
        ...(binding.name ? { name: binding.name } : {}),
        supportsEdit: binding.supportsEdit,
        wireModel: binding.wireModel,
        litellmModel: binding.litellmModel,
      };
    }
    providers.push({
      id: item.id,
      name: item.name,
      connectionRevision: item.connectionRevision,
      models: parsedModels,
      ...(imageBinding ? { imageBinding } : {}),
    });
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      organizationId: value.organizationId,
      revision: value.revision,
      providers,
    },
  };
}

function validEndpoint(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    const loopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    return (
      (url.protocol === "https:" || loopbackHttp) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseByokCredentialsResponse(
  value: unknown,
): Parsed<ByokCredentialsResponse> {
  if (
    !envelope(value) ||
    !fields(value, ["schemaVersion", "organizationId", "credentials"]) ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > 100
  ) {
    return fail("Invalid BYOK credentials response");
  }
  const ids = new Set<string>();
  const credentials: ByokCredential[] = [];
  for (const item of value.credentials) {
    if (
      !record(item) ||
      !isByokProviderId(item.providerId) ||
      ids.has(item.providerId) ||
      !revision(item.connectionRevision)
    )
      return fail("Invalid or duplicate BYOK credential");
    const common = {
      providerId: item.providerId,
      connectionRevision: item.connectionRevision,
    };
    const allowed = ["providerId", "connectionRevision", "status"];
    if (
      item.status === "ready" &&
      fields(item, [...allowed, "endpoint", "apiKey"]) &&
      validEndpoint(item.endpoint) &&
      text(item.apiKey, 8192)
    ) {
      credentials.push({
        ...common,
        status: "ready",
        endpoint: item.endpoint,
        apiKey: item.apiKey,
      });
    } else if (item.status === "pending" && fields(item, allowed)) {
      credentials.push({ ...common, status: "pending" });
    } else if (
      item.status === "error" &&
      fields(item, [...allowed, "code"]) &&
      (item.code === "UNAVAILABLE" || item.code === "REVOKED")
    ) {
      credentials.push({ ...common, status: "error", code: item.code });
    } else return fail("Invalid BYOK credential state");
    ids.add(item.providerId);
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      organizationId: value.organizationId,
      credentials,
    },
  };
}
