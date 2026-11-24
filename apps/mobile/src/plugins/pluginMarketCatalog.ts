import {
  isBoundedPluginResponse,
  parsePluginManagementSnapshot,
  type ManagedMarketItem,
} from "./pluginManagementTypes";

/**
 * Mobile projection of the Host `management:snapshot {read:'catalog'}` page.
 * The executing computer owns query, source, version and installed-state facts;
 * the phone only browses one page at a time and never falls back to a full read.
 */
export type PluginMarketScope =
  | "all"
  | "public"
  | "organization"
  | "personal"
  | "custom";
/** Source filter shown to the user; official/community are publisher subsets of public. */
export type PluginMarketFilter =
  | "all"
  | "official"
  | "community"
  | "organization"
  | "custom";
export interface PluginMarketQuery {
  query?: string;
  scope?: PluginMarketScope;
  cursor?: string | null;
  limit?: number;
  excludeInstalled?: boolean;
  counts?: boolean;
}
export interface PluginMarketCounts {
  all: number;
  public: number;
  organization: number;
  personal: number;
  custom: number;
  /** Subsets of public; older Hosts omit the breakdown. */
  official?: number;
  community?: number;
}
export interface PluginMarketPage {
  items: ManagedMarketItem[];
  unavailableReason: string | null;
  customSourceNames: string[];
  unavailableCustomSourceNames: string[];
  organizationAccessError: string | null;
  nextCursor: string | null;
  counts: PluginMarketCounts | null;
}

export const PLUGIN_MARKET_QUERY_MAX = 100;
const PAGE_ITEMS_MAX = 100;
const CURSOR_MAX = 2048;
const COUNT_KEYS = ["all", "public", "organization", "personal", "custom"] as const;

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function invalid(): never {
  throw new Error("INVALID_RESPONSE");
}

function parseCounts(value: unknown): PluginMarketCounts | null {
  if (value === undefined || value === null) return null;
  if (!record(value) || !COUNT_KEYS.every((key) => count(value[key]))) invalid();
  for (const key of ["official", "community"] as const)
    if (value[key] !== undefined && !count(value[key])) invalid();
  const counts = value as unknown as PluginMarketCounts;
  if (
    (counts.official ?? 0) + (counts.community ?? 0) > counts.public ||
    counts.all !==
      counts.public + counts.organization + counts.personal + counts.custom
  )
    invalid();
  return {
    all: counts.all,
    public: counts.public,
    organization: counts.organization,
    personal: counts.personal,
    custom: counts.custom,
    ...(counts.official !== undefined ? { official: counts.official } : {}),
    ...(counts.community !== undefined ? { community: counts.community } : {}),
  };
}

const ITEM_FIELDS = ["pluginId", "ghostId", "namespace", "name", "description", "author", "publisherKind", "scope",
  "organizationId", "defaultInstall", "releaseId", "version", "publishedAt", "icon", "installState", "enabled",
  "sourceType", "sourceMarketName", "updateRequiresConsent"] as const;
/** Keep only the list fields the phone shows or sends back; extra Host fields are not retained. */
function marketItemFields(item: ManagedMarketItem): ManagedMarketItem {
  const picked: Record<string, unknown> = {};
  for (const key of ITEM_FIELDS) if (Object.hasOwn(item, key)) picked[key] = item[key];
  return picked as unknown as ManagedMarketItem;
}

/**
 * Bounded, whitelisted page parser. Fields added after the first paging Host
 * (`publisherKind`, `organizationAccessError`, `counts`, `nextCursor`) are optional:
 * missing means "not known", never a crash. Present but malformed data is rejected.
 */
export function parsePluginMarketPage(value: unknown): PluginMarketPage {
  if (!isBoundedPluginResponse(value) || !record(value) || !Array.isArray(value.items)
    || value.items.length > PAGE_ITEMS_MAX) invalid();
  const nextCursor = value.nextCursor ?? null;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > CURSOR_MAX)) invalid();
  const market = parsePluginManagementSnapshot({
    version: 1,
    ghosts: [],
    market: {
      items: value.items,
      unavailableReason: value.unavailableReason ?? null,
      customSourceNames: value.customSourceNames ?? [],
      unavailableCustomSourceNames: value.unavailableCustomSourceNames ?? [],
      ...(value.organizationAccessError !== undefined
        ? { organizationAccessError: value.organizationAccessError }
        : {}),
    },
  }).market;
  return {
    items: market.items.map(marketItemFields),
    unavailableReason: market.unavailableReason,
    customSourceNames: market.customSourceNames,
    unavailableCustomSourceNames: market.unavailableCustomSourceNames,
    organizationAccessError: market.organizationAccessError ?? null,
    nextCursor,
    counts: parseCounts(value.counts),
  };
}

/** Validates the outgoing query against the Host contract before it is sent. */
export function pluginMarketQueryInput(input: PluginMarketQuery): Record<string, unknown> {
  const query = (input.query ?? "").trim();
  const limit = input.limit ?? 20;
  if (query.length > PLUGIN_MARKET_QUERY_MAX || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_ITEMS_MAX
    || (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== "string" || input.cursor.length > CURSOR_MAX))
    || (input.scope !== undefined && !["all", "public", "organization", "personal", "custom"].includes(input.scope)))
    throw new Error("INVALID_INPUT");
  return {
    ...(query ? { query } : {}),
    scope: input.scope ?? "all",
    limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.excludeInstalled !== undefined ? { excludeInstalled: input.excludeInstalled } : {}),
    ...(input.counts !== undefined ? { counts: input.counts } : {}),
  };
}

/** Publisher tabs browse the same public pages, filtered locally, as on the computer. */
export function pluginMarketRequest(filter: PluginMarketFilter, query: string): { scope: PluginMarketScope; limit: number } {
  if (query.trim()) return { scope: "all", limit: 20 };
  if (filter === "official" || filter === "community") return { scope: "public", limit: 100 };
  return { scope: filter, limit: 20 };
}

export function pluginMarketPublisher(item: Pick<ManagedMarketItem, "scope" | "sourceType" | "publisherKind">): "official" | "community" | null {
  if (item.sourceType !== "server" || item.scope !== "public") return null;
  return item.publisherKind === "official" ? "official" : item.publisherKind === "personal" ? "community" : null;
}

/** Source label next to the name: official / community / team shared / custom. */
export function pluginMarketOrigin(item: ManagedMarketItem): "official" | "community" | "organization" | "custom" | null {
  if (item.sourceType !== "server") return "custom";
  if (item.scope === "organization") return "organization";
  return pluginMarketPublisher(item);
}

export function pluginMarketMatchesFilter(item: ManagedMarketItem, filter: PluginMarketFilter): boolean {
  return filter === "official" || filter === "community" ? pluginMarketPublisher(item) === filter : true;
}

/** Public community authors stay anonymous, matching the computer's presentation. */
export function pluginMarketAuthor(item: ManagedMarketItem): string | null {
  return item.sourceType === "server" && item.scope === "public" && item.publisherKind !== "official" ? null : item.author;
}

/** Only short-lived HTTPS links from the market are loaded; custom markets have no remote icon. */
export function pluginMarketIconUri(item: Pick<ManagedMarketItem, "icon">, now = Date.now()): string | undefined {
  const icon = item.icon;
  if (!icon) return undefined;
  const expiresAt = Date.parse(icon.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  try {
    return new URL(icon.url).protocol === "https:" ? icon.url : undefined;
  } catch {
    return undefined;
  }
}

/** Host and controller error codes → mobile copy keys, aligned with the computer's market errors. */
export function pluginMarketErrorKey(code: string | null | undefined): string {
  switch (code) {
    case "PLUGIN_NAMESPACE_CLIENT_REQUIRED":
    case "PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE":
    case "PLUGIN_NAMESPACE_CONFIG_REQUIRED":
      return pluginMarketOrganizationErrorKey(code)!;
    case "INVALID_PARAMS": return "plugins.market.errors.invalidRequest";
    case "NOT_FOUND": return "plugins.market.errors.notFound";
    case "ALREADY_EXISTS": return "plugins.market.errors.conflict";
    case "PLUGIN_RELEASE_CHANGED": return "plugins.management.releaseChanged";
    case "PRECONDITION_FAILED":
    case "PLUGIN_INSTALL_CHANGED": return "plugins.market.errors.stateChanged";
    case "PLUGIN_LIST_CHANGED": return "plugins.market.errors.listChanged";
    case "PERMISSION_DENIED": return "plugins.market.errors.accessDenied";
    case "UNSUPPORTED_CAPABILITY": return "plugins.market.errors.notConfigured";
    case "GHOST_FILE_INVALID": return "plugins.market.errors.invalidPackage";
    case "GHOST_DOWNLOAD_AUTHORIZATION_EXPIRED": return "plugins.market.errors.downloadAuthorizationExpired";
    case "GHOST_DOWNLOAD_TIMEOUT": return "plugins.market.errors.downloadTimeout";
    case "GHOST_DOWNLOAD_FAILED": return "plugins.market.errors.downloadFailed";
    case "GHOST_ID_RESERVED": return "plugins.market.errors.idReserved";
    case "GHOST_BROKER_REDIRECT_PORT_REQUIRED": return "plugins.market.errors.brokerRedirectPortRequired";
    case "GHOST_HOST_UNSUPPORTED": return "plugins.market.errors.hostUnsupported";
    case "DEVICE_OFFLINE":
    case "PLUGIN_MANAGEMENT_STALE": return "plugins.actionFailed";
    default: return "plugins.market.errors.generic";
  }
}

export function pluginMarketOrganizationErrorKey(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "PLUGIN_NAMESPACE_CLIENT_REQUIRED": return "plugins.market.errors.namespaceClientRequired";
    case "PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE": return "plugins.market.errors.organizationContextUnavailable";
    case "PLUGIN_NAMESPACE_CONFIG_REQUIRED": return "plugins.market.errors.namespaceConfigRequired";
    default: return "plugins.market.errors.organizationUnavailable";
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "Public · v1.4.2 · Cindy" under the name; community authors are omitted. */
export function pluginMarketSubtitle(item: ManagedMarketItem, t: Translate): string {
  const author = pluginMarketAuthor(item);
  return [item.sourceType === "server" ? t("plugins.market.scope." + item.scope) : item.sourceMarketName ?? "",
    "v" + item.version, author ?? ""].filter(Boolean).join(" · ");
}

export function pluginMarketPublisherKey(item: ManagedMarketItem): string | null {
  const origin = pluginMarketOrigin(item);
  return origin ? "plugins.market.publisherDescription." + origin : null;
}

/** Tool names declared by the release manifest; malformed declarations are simply not shown. */
export function pluginMarketTools(manifest: Record<string, unknown> | undefined): Array<{ name: string; description: string }> {
  const tools = manifest?.tools;
  if (!Array.isArray(tools) || tools.length > 200) return [];
  return tools.flatMap((tool) => record(tool) && typeof tool.name === "string" && tool.name && tool.name.length <= 128
    ? [{ name: tool.name, description: typeof tool.description === "string" ? tool.description.slice(0, 1024) : "" }] : []);
}

export function pluginMarketFacts(item: ManagedMarketItem, t: Translate): Array<{ key: string; title: string; value: string }> {
  return [
    { key: "version", title: t("plugins.detail.version"), value: item.version },
    { key: "source", title: t("plugins.market.source"),
      value: item.sourceType === "server" ? t("plugins.market.title") : item.sourceMarketName ?? t("plugins.market.filter.custom") },
    { key: "identifier", title: t("plugins.detail.identifier"), value: item.ghostId },
  ].filter((fact) => fact.value);
}
