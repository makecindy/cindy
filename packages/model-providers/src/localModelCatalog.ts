/** Registry V4 local-model curation. Data only; execution stays in the client. */
export interface LocalModelVariant {
  libraryName: string;
  sizeBytes: number;
  minUnifiedMemoryGb: number;
  appleSiliconOnly?: boolean;
}
export interface LocalCatalogModel {
  modelRef?: string;
  id: string;
  name: string;
  aliases: string[];
  variants: LocalModelVariant[];
  descriptions?: Partial<
    Record<"en" | "zh-CN" | "zh-TW" | "ja" | "ko", string>
  >;
  /** Existing client implementation, never executable server instructions. */
  runtimeProfile?: "plain" | "qwen-xhigh";
  evidence?: {
    url: string;
    verifiedAt: string;
    status: "measured" | "estimated" | "pending";
  }[];
}
export interface LocalModelCatalog {
  version: 1;
  models: LocalCatalogModel[];
  /** Ordered capability/speed picks; empty explicitly withdraws recommendations. */
  featuredIds: string[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((key) => keys.includes(key));
const string = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
const https = (v: unknown) => {
  if (!string(v, 2048)) return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};
export function isLocalModelLibraryName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 256 &&
    /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
      v,
    )
  );
}
/** Reject the entire invalid snapshot so it can never replace a good cached catalog. */
export function parseLocalModelCatalog(v: unknown): LocalModelCatalog | null {
  if (
    !object(v) ||
    !fields(v, ["version", "models", "featuredIds"]) ||
    v.version !== 1 ||
    !Array.isArray(v.models) ||
    v.models.length > 32 ||
    !Array.isArray(v.featuredIds) ||
    v.featuredIds.length > 8 ||
    !v.featuredIds.every(id)
  )
    return null;
  const ids = new Set<string>();
  const tags = new Set<string>();
  for (const m of v.models) {
    if (
      !object(m) ||
      !fields(m, [
        "id",
        "modelRef",
        "name",
        "aliases",
        "variants",
        "descriptions",
        "runtimeProfile",
        "evidence",
      ]) ||
      !id(m.id) ||
      (m.modelRef !== undefined && !string(m.modelRef, 256)) ||
      ids.has(m.id) ||
      !string(m.name, 80) ||
      !Array.isArray(m.aliases) ||
      m.aliases.length > 16 ||
      !m.aliases.every((a) => string(a, 40)) ||
      !Array.isArray(m.variants) ||
      m.variants.length < 1 ||
      m.variants.length > 8
    )
      return null;
    ids.add(m.id);
    for (const tag of m.variants) {
      if (
        !object(tag) ||
        !fields(tag, [
          "libraryName",
          "sizeBytes",
          "minUnifiedMemoryGb",
          "appleSiliconOnly",
        ]) ||
        !isLocalModelLibraryName(tag.libraryName) ||
        tags.has(tag.libraryName) ||
        typeof tag.sizeBytes !== "number" ||
        !Number.isSafeInteger(tag.sizeBytes) ||
        tag.sizeBytes < 1024 ** 3 ||
        tag.sizeBytes > 512 * 1024 ** 3 ||
        typeof tag.minUnifiedMemoryGb !== "number" ||
        !Number.isInteger(tag.minUnifiedMemoryGb) ||
        tag.minUnifiedMemoryGb < 4 ||
        tag.minUnifiedMemoryGb > 1024 ||
        (tag.appleSiliconOnly !== undefined &&
          typeof tag.appleSiliconOnly !== "boolean")
      )
        return null;
      if (
        /(?:^|[-_.])mlx(?:$|[-_.])/.test(tag.libraryName.split(":")[1] ?? "") &&
        tag.appleSiliconOnly !== true
      )
        return null;
      tags.add(tag.libraryName);
    }
    if (
      m.runtimeProfile !== undefined &&
      !["plain", "qwen-xhigh"].includes(m.runtimeProfile as string)
    )
      return null;
    if (
      m.runtimeProfile === "qwen-xhigh" &&
      !m.variants.every((tag) =>
        ["qwen3.8:27b", "qwen3.8:27b-mlx", "qwen3.8:27b-mxfp8"].includes(
          tag.libraryName,
        ),
      )
    )
      return null;
    if (
      m.descriptions !== undefined &&
      (!object(m.descriptions) ||
        !fields(m.descriptions, ["en", "zh-CN", "zh-TW", "ja", "ko"]) ||
        !Object.values(m.descriptions).every((s) => string(s, 500)))
    )
      return null;
    if (m.evidence !== undefined) {
      if (!Array.isArray(m.evidence) || m.evidence.length > 8) return null;
      for (const e of m.evidence) {
        if (
          !object(e) ||
          !fields(e, ["url", "verifiedAt", "status"]) ||
          !https(e.url) ||
          typeof e.verifiedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(e.verifiedAt) ||
          !Number.isFinite(Date.parse(e.verifiedAt)) ||
          new Date(e.verifiedAt).toISOString().slice(0, 10) !== e.verifiedAt ||
          !["measured", "estimated", "pending"].includes(e.status as string)
        )
          return null;
      }
    }
  }
  if (
    new Set(v.featuredIds).size !== v.featuredIds.length ||
    !v.featuredIds.every((key) => ids.has(key))
  )
    return null;
  return v as unknown as LocalModelCatalog;
}
