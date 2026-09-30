/** Host-owned favorite configuration copies. No credentials or executable routing data. */
export const MODEL_FAVORITES_GET = "maker:model-favorites:get";
export const MODEL_FAVORITES_APPLY = "maker:model-favorites:apply";
export const MODEL_FAVORITES_CHANGED = "maker:model-favorites:changed";
export interface RemoteModelFavorite {
  uid: string;
  providerId: string;
  modelId: string;
  agent: "cc" | "codex" | "pi";
  effort?: string;
  fast?: true;
}
export type ModelFavoriteMutation =
  | { kind: "add"; item: Omit<RemoteModelFavorite, "uid"> }
  | {
      kind: "update";
      expected: RemoteModelFavorite;
      item: Omit<RemoteModelFavorite, "uid">;
    }
  | { kind: "remove"; expected: RemoteModelFavorite };
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512;
export function parseRemoteModelFavorite(
  value: unknown,
  needsUid = true,
): RemoteModelFavorite {
  if (!value || typeof value !== "object")
    throw new Error("Invalid model favorite");
  const p = value as RemoteModelFavorite;
  if (
    (needsUid && !text(p.uid)) ||
    !text(p.providerId) ||
    p.providerId === "*" ||
    !text(p.modelId) ||
    !["cc", "codex", "pi"].includes(p.agent) ||
    (p.effort !== undefined &&
      !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
        p.effort,
      )) ||
    (p.fast !== undefined && p.fast !== true)
  )
    throw new Error("Invalid model favorite");
  return {
    uid: needsUid ? p.uid : "",
    providerId: p.providerId,
    modelId: p.modelId,
    agent: p.agent,
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.fast ? { fast: true } : {}),
  };
}
export function parseModelFavoriteMutation(
  value: unknown,
): ModelFavoriteMutation {
  if (!value || typeof value !== "object")
    throw new Error("Invalid favorite operation");
  const p = value as ModelFavoriteMutation;
  if (p.kind === "add")
    return { kind: p.kind, item: parseRemoteModelFavorite(p.item, false) };
  if (p.kind === "remove")
    return { kind: p.kind, expected: parseRemoteModelFavorite(p.expected) };
  if (p.kind === "update") {
    const expected = parseRemoteModelFavorite(p.expected),
      item = parseRemoteModelFavorite(p.item, false);
    if (
      expected.providerId !== item.providerId ||
      expected.modelId !== item.modelId
    )
      throw new Error("Favorite identity cannot change");
    return { kind: p.kind, expected, item };
  }
  throw new Error("Invalid favorite operation");
}
export function parseModelFavorites(value: unknown): RemoteModelFavorite[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error("Invalid favorites snapshot");
  const items = value.map((item) => parseRemoteModelFavorite(item));
  if (new Set(items.map((item) => item.uid)).size !== items.length)
    throw new Error("Duplicate favorite identity");
  return items;
}
export function sameModelFavorite(
  a: RemoteModelFavorite,
  b: RemoteModelFavorite,
): boolean {
  return (
    a.uid === b.uid &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.agent === b.agent &&
    a.effort === b.effort &&
    !!a.fast === !!b.fast
  );
}
