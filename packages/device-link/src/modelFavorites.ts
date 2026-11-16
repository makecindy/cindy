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
  fast?: true | "ultrafast";
}
export type ModelFavoriteMutation =
  | { kind: "add"; item: Omit<RemoteModelFavorite, "uid"> }
  | {
      kind: "update";
      expected: RemoteModelFavorite;
      item: Omit<RemoteModelFavorite, "uid">;
    }
  | { kind: "remove"; expected: RemoteModelFavorite };
export const MODEL_FAVORITE_TEXT_MAX_LENGTH = 512;
/**
 * Desktop 本机收藏能放下带分享与成员身份的来源键。收藏通道仍用上面的 512：
 * 更长的键若出现在回复里，旧客户端会整表解析失败。
 */
export const PROVIDER_SHARE_FAVORITE_SOURCE_MAX_LENGTH = 2048;
const text = (v: unknown, max = MODEL_FAVORITE_TEXT_MAX_LENGTH): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * 收藏里「在同账号另一台电脑上运行」的来源：位置编进 providerId，收藏仍存在被控电脑上。
 * 不另加字段 —— 旧版解析会丢掉不认识的字段，把那台电脑的供应商当成被控电脑的同名供应商，
 * 任务就派错了地方；编进 providerId 后旧版只会看到一个不认识的供应商并把这条藏起来。
 * 只用于收藏的存储与匹配，绝不作为模型请求的 providerId。
 */
const AGENT_DEVICE_FAVORITE_PREFIX = "agent-device-favorite:";
export interface AgentDeviceFavoriteSource {
  deviceId: string;
  providerId: string;
}
export function agentDeviceFavoriteSource(source: AgentDeviceFavoriteSource): string {
  const key = AGENT_DEVICE_FAVORITE_PREFIX + JSON.stringify([source.deviceId, source.providerId]);
  if (!text(source.deviceId) || !text(source.providerId) || !text(key))
    throw new Error("Invalid agent device favorite source");
  return key;
}
export function parseAgentDeviceFavoriteSource(value: string): AgentDeviceFavoriteSource | null {
  if (!value.startsWith(AGENT_DEVICE_FAVORITE_PREFIX)) return null;
  try {
    const parts: unknown = JSON.parse(value.slice(AGENT_DEVICE_FAVORITE_PREFIX.length));
    if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((part) => text(part)))
      return null;
    return { deviceId: parts[0], providerId: parts[1] };
  } catch {
    return null;
  }
}

/**
 * 分享来的模型收藏：键里带分享、成员、供应商与归属区域，存在受邀者账号的收藏里。
 * 投影回目录时才换成真实 providerId，绝不把这个键用于模型请求。
 * 老客户端不认识此前缀，只会把它当成不认识的供应商藏起来，不会派到本机同名供应商。
 */
const PROVIDER_SHARE_FAVORITE_PREFIX = "provider-share-favorite:";
export interface ProviderShareFavoriteSource {
  shareId: string;
  memberId: string;
  providerId: string;
  owner: { region: "cn" | "global" };
}
export function providerShareFavoriteSource(source: ProviderShareFavoriteSource): string {
  const key = PROVIDER_SHARE_FAVORITE_PREFIX + JSON.stringify([
    source.shareId, source.memberId, source.providerId, source.owner.region,
  ]);
  if (!source.shareId || !source.memberId || !source.providerId
    || key.length > PROVIDER_SHARE_FAVORITE_SOURCE_MAX_LENGTH)
    throw new Error("Invalid shared favorite source");
  return key;
}
export function parseProviderShareFavoriteSource(value: string): {
  shareId: string; memberId: string; providerId: string; region: "cn" | "global";
} | null {
  if (!value.startsWith(PROVIDER_SHARE_FAVORITE_PREFIX)) return null;
  try {
    const parts: unknown = JSON.parse(value.slice(PROVIDER_SHARE_FAVORITE_PREFIX.length));
    if (!Array.isArray(parts) || parts.length !== 4
      || !parts.every((part) => typeof part === "string" && part.length > 0)
      || (parts[3] !== "cn" && parts[3] !== "global"))
      return null;
    return { shareId: parts[0], memberId: parts[1], providerId: parts[2], region: parts[3] };
  } catch {
    return null;
  }
}
/** 收藏通道能往返的分享来源键。更长的键 Desktop 本机仍可存，但手机会整表读失败，所以不提供星标。 */
export function providerShareFavoriteWireKey(source: ProviderShareFavoriteSource): string | null {
  try {
    const key = providerShareFavoriteSource(source);
    return key.length <= MODEL_FAVORITE_TEXT_MAX_LENGTH ? key : null;
  } catch {
    return null;
  }
}
export function parseRemoteModelFavorite(
  value: unknown,
  needsUid = true,
  providerIdMaxLength = MODEL_FAVORITE_TEXT_MAX_LENGTH,
): RemoteModelFavorite {
  if (!value || typeof value !== "object")
    throw new Error("Invalid model favorite");
  const p = value as RemoteModelFavorite;
  if (
    (needsUid && !text(p.uid)) ||
    !text(p.providerId, providerIdMaxLength) ||
    p.providerId === "*" ||
    !text(p.modelId) ||
    !["cc", "codex", "pi"].includes(p.agent) ||
    (p.effort !== undefined &&
      !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
        p.effort,
      )) ||
    (p.fast !== undefined && p.fast !== true && p.fast !== "ultrafast")
  )
    throw new Error("Invalid model favorite");
  return {
    uid: needsUid ? p.uid : "",
    providerId: p.providerId,
    modelId: p.modelId,
    agent: p.agent,
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.fast ? { fast: p.fast } : {}),
  };
}
export function parseModelFavoriteMutation(
  value: unknown,
  // Local composite source keys may be longer; wire callers retain the default.
  providerIdMaxLength = MODEL_FAVORITE_TEXT_MAX_LENGTH,
): ModelFavoriteMutation {
  if (!value || typeof value !== "object")
    throw new Error("Invalid favorite operation");
  const p = value as ModelFavoriteMutation;
  if (p.kind === "add")
    return { kind: p.kind, item: parseRemoteModelFavorite(p.item, false, providerIdMaxLength) };
  if (p.kind === "remove")
    return { kind: p.kind, expected: parseRemoteModelFavorite(p.expected, true, providerIdMaxLength) };
  if (p.kind === "update") {
    const expected = parseRemoteModelFavorite(p.expected, true, providerIdMaxLength),
      item = parseRemoteModelFavorite(p.item, false, providerIdMaxLength);
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
    (a.fast ?? false) === (b.fast ?? false)
  );
}
