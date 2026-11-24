import { PLUGIN_COLLECTION, type RemoteCollectionItem } from "@cindy/device-link";
import type { ManagedMarketItem, ManagedPlugin } from "@/plugins/pluginManagementTypes";

/**
 * `--mock` plugin market (docs/dev-rules/ui-mock-data.md). Fictional "Demo" plugins on the
 * online mock computer, served through the real management wire shapes so the phone's market
 * list, detail, consent sheet and failure states can be checked without a computer.
 * Writes live only in this process. Scenario links: cindy://plugins?market=<scenario>.
 */
export type PluginMarketVisualScenario =
  | "normal" | "outdated" | "unavailable" | "organization" | "customPartial" | "empty" | "readFailed";
const SCENARIOS: PluginMarketVisualScenario[] = ["normal", "outdated", "unavailable", "organization", "customPartial", "empty", "readFailed"];
let scenario: PluginMarketVisualScenario = "normal";
let failedReads = 0;

/** Applies a deep-link scenario; returns true when the market tab should open. */
export function setPluginMarketVisualScenario(value: unknown, enabled: boolean): boolean {
  if (!enabled || typeof value !== "string" || !SCENARIOS.includes(value as PluginMarketVisualScenario)) return false;
  scenario = value as PluginMarketVisualScenario;
  failedReads = 0;
  return true;
}

interface DemoPlugin {
  ghostId: string;
  name: string;
  description: string;
  author: string | null;
  publisher: "official" | "personal" | "organization" | "custom";
  tools: string[];
  /** Install outcome after the package check: consent (default), download failure, or a lost begin reply. */
  outcome?: "downloadFailed" | "uncertain";
  conflict?: boolean;
}
const DEMOS: DemoPlugin[] = [
  { ghostId: "demo-device-simulator", name: "Demo Device Simulator", publisher: "official", author: "Cindy",
    description: "Open a phone simulator in a task, take screenshots, tap and type into the app you are building.",
    tools: ["demo_boot_device", "demo_screenshot", "demo_tap", "demo_type_text", "demo_install_app"] },
  { ghostId: "demo-calendar", name: "Demo Calendar", publisher: "official", author: "Cindy",
    description: "View, create and adjust events across several calendar accounts.", tools: ["demo_list_events", "demo_create_event"] },
  { ghostId: "demo-image-studio", name: "Demo Image Studio", publisher: "official", author: "Cindy",
    description: "Generate and edit images in a conversation and keep the results in the library.", tools: ["demo_generate_image"] },
  { ghostId: "demo-glossary", name: "Demo Glossary Translate", publisher: "official", author: "Cindy", outcome: "downloadFailed",
    description: "Translate documents with a glossary so names stay consistent. Installing it shows a download failure.",
    tools: ["demo_translate"] },
  { ghostId: "demo-uncertain-sync", name: "Demo Uncertain Sync", publisher: "official", author: "Cindy", outcome: "uncertain",
    description: "The install reply is lost on purpose; use Check result to confirm what happened.", tools: ["demo_sync"] },
  { ghostId: "demo-shift-calendar", name: "Demo Shift Calendar", publisher: "personal", author: "community-author",
    description: "Build a shift rota and sync it to a calendar.", tools: ["demo_build_rota"] },
  { ghostId: "demo-team-sheets", name: "Demo Team Sheets", publisher: "organization", author: "Demo Org",
    description: "Read and write the team's shared tables.", tools: ["demo_read_table", "demo_write_table"] },
  { ghostId: "demo-notes", name: "Demo Notes", publisher: "custom", author: null, conflict: true,
    description: "A same-ID plugin is already installed on this computer, so it cannot be installed here.", tools: [] },
  ...Array.from({ length: 26 }, (_, index): DemoPlugin => ({
    ghostId: `demo-extension-${index + 1}`, name: `Demo Extension ${index + 1}`, publisher: index % 3 ? "personal" : "official",
    author: index % 3 ? "community-author" : "Cindy", description: "A filler entry that exercises paging and long lists.", tools: ["demo_tool"],
  })),
];
const CUSTOM_MARKET = "Demo Git Market";
const OFFLINE_MARKET = "Demo Offline Market";
const installed = new Map<string, { demo: DemoPlugin; enabled: boolean }>();
const operations = new Map<string, { kind: "install" | "uninstall"; ghostId: string; answered: boolean; polls: number; done?: "succeeded" | "failed" | "cancelled" }>();
const instanceKey = (ghostId: string) => `_root__${ghostId}`;
const failure = (code: string) => Object.assign(new Error(code), { code });

function marketItem(demo: DemoPlugin): ManagedMarketItem {
  const server = demo.publisher !== "custom";
  return {
    pluginId: `demo-market/${demo.ghostId}`, ghostId: demo.ghostId, namespace: null, name: demo.name,
    description: demo.description, author: demo.author,
    ...(server && demo.publisher !== "organization" ? { publisherKind: demo.publisher === "official" ? "official" as const : "personal" as const } : {}),
    scope: demo.publisher === "organization" ? "organization" : "public",
    organizationId: demo.publisher === "organization" ? "demo-org" : null, defaultInstall: false,
    releaseId: `${demo.ghostId}@1.4.2`, version: "1.4.2", publishedAt: "2026-11-01T00:00:00.000Z", icon: null,
    installState: demo.conflict ? "conflict" : installed.has(instanceKey(demo.ghostId)) ? "installed" : "not-installed",
    enabled: installed.get(instanceKey(demo.ghostId))?.enabled ?? null,
    sourceType: server ? "server" : "git-market", sourceMarketName: server ? null : CUSTOM_MARKET,
  };
}
const manifest = (demo: DemoPlugin) => ({
  schemaVersion: 3, id: demo.ghostId, name: demo.name, version: "1.4.2", description: demo.description,
  ...(demo.author ? { author: demo.author } : {}),
  tools: demo.tools.map((name) => ({ name, description: "Example capability" })),
});
const demoFor = (pluginId: unknown) => DEMOS.find((demo) => `demo-market/${demo.ghostId}` === pluginId);

function catalog(query: Record<string, unknown> = {}) {
  if (scenario === "readFailed" && failedReads++ < 1) throw failure("TIMEOUT");
  const text = typeof query.query === "string" ? query.query.trim().toLocaleLowerCase() : "";
  const scope = typeof query.scope === "string" ? query.scope : "all";
  const visible = DEMOS.map(marketItem).filter((item) => item.installState !== "installed"
    && (scenario !== "organization" || item.scope !== "organization")
    && `${item.name} ${item.description} ${item.ghostId}`.toLocaleLowerCase().includes(text));
  const matches = scenario === "empty" || scenario === "unavailable" ? [] : visible;
  const inScope = matches.filter((item) => scope === "all" ? true : scope === "custom" ? item.sourceType !== "server"
    : item.sourceType === "server" && item.scope === scope);
  const offset = typeof query.cursor === "string" ? Number(query.cursor) : 0;
  const limit = typeof query.limit === "number" ? query.limit : 20;
  const page = inScope.slice(offset, offset + limit);
  const server = matches.filter((item) => item.sourceType === "server");
  const counts = {
    public: server.filter((item) => item.scope === "public").length,
    organization: server.filter((item) => item.scope === "organization").length, personal: 0,
    custom: matches.length - server.length,
    official: server.filter((item) => item.publisherKind === "official").length,
    community: server.filter((item) => item.publisherKind === "personal").length,
  };
  return {
    items: page,
    unavailableReason: scenario === "unavailable" ? "MARKET_UNAVAILABLE" : null,
    customSourceNames: scenario === "customPartial" ? [CUSTOM_MARKET, OFFLINE_MARKET] : [CUSTOM_MARKET],
    unavailableCustomSourceNames: scenario === "customPartial" ? [OFFLINE_MARKET] : [],
    organizationAccessError: scenario === "organization" ? "PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE" : null,
    nextCursor: offset + page.length < inScope.length ? String(offset + page.length) : null,
    counts: query.counts === true ? { ...counts, all: counts.public + counts.organization + counts.custom } : null,
  };
}
function ghost(key: string, entry: { demo: DemoPlugin; enabled: boolean }): ManagedPlugin {
  return { instanceKey: key, namespace: null, manifest: manifest(entry.demo) as ManagedPlugin["manifest"], enabled: entry.enabled,
    approval: { state: "approved", revision: "12345678-1234-4123-8123-123456789abc" } };
}
function snapshot() {
  return { version: 1, ghosts: [...installed].map(([key, entry]) => ghost(key, entry)),
    market: { items: DEMOS.map(marketItem), unavailableReason: null, customSourceNames: [CUSTOM_MARKET], unavailableCustomSourceNames: [] } };
}
function receipt(operationId: string) {
  const op = operations.get(operationId);
  if (!op) throw failure("NOT_FOUND");
  op.polls += 1;
  const demo = DEMOS.find((item) => item.ghostId === op.ghostId)!;
  if (op.done) return { operationId, phase: op.done, ...(op.done === "failed" ? { errorCode: "GHOST_DOWNLOAD_FAILED" } : {}) };
  if (op.kind === "uninstall") { installed.delete(instanceKey(op.ghostId)); op.done = "succeeded"; return { operationId, phase: "succeeded" }; }
  if (demo.outcome === "downloadFailed") { op.done = "failed"; return receipt(operationId); }
  if (!op.answered) return { operationId, phase: "confirmation", consent: {
    requestId: `demo-consent-${operationId}`, initiator: "user", origin: demo.publisher === "custom" ? "custom-market" : "market",
    ...(demo.publisher === "custom" ? { originLabel: CUSTOM_MARKET } : {}),
    trust: demo.publisher === "official" ? "cindy-official" : "reviewed",
    facts: { kind: "install", ghostId: demo.ghostId, name: demo.name, version: "1.4.2", permissions: [
      ...demo.tools.map((name) => ({ key: `tool:${name}`, kind: "tool", labelKey: "tool", labelArgs: { name } })),
      ...(demo.ghostId === "demo-device-simulator" ? [
        { key: "panel", kind: "panel", labelKey: "panelTab", labelArgs: { title: demo.name } },
        { key: "node", kind: "node-runtime", labelKey: "nodeRuntime", detailKey: "nodeRuntimeDetail" },
      ] : []),
    ] } } };
  // Two polls of "installing" after consent, then the install commits.
  if (op.polls < 3) return { operationId, phase: "running" };
  installed.set(instanceKey(demo.ghostId), { demo, enabled: true });
  op.done = "succeeded";
  return { operationId, phase: "succeeded" };
}

/** Management actions of the `plugins` collection; undefined for anything else. */
export function pluginMarketVisualManagement(actionId: string | undefined, input: Record<string, unknown> = {}, resourceId?: string): unknown {
  const result = (value: unknown) => ({ effects: [], result: value });
  switch (actionId) {
    case "management:snapshot":
      if (input.read === "capabilities") {
        // An older Host rejects any non-empty snapshot input.
        if (scenario === "outdated") throw failure("INVALID_PARAMS");
        return result({ catalogPaging: true });
      }
      if (input.read === "catalog") return result(catalog(input.query as Record<string, unknown>));
      if (input.read === "recommendations") return result([]);
      return result(snapshot());
    case "management:market-detail": {
      const demo = demoFor(input.pluginId);
      if (!demo) throw failure("NOT_FOUND");
      return result({ ...marketItem(demo), manifest: manifest(demo) });
    }
    case "management:begin": {
      const operationId = String(input.operationId);
      if (input.kind === "uninstall") {
        const entry = resourceId ? installed.get(resourceId) : undefined;
        if (!entry) throw failure("PRECONDITION_FAILED");
        operations.set(operationId, { kind: "uninstall", ghostId: entry.demo.ghostId, answered: true, polls: 0 });
        return result({ operationId, phase: "running" });
      }
      const demo = demoFor(input.pluginId);
      if (!demo || input.kind !== "install" || input.expectedReleaseId !== `${demo.ghostId}@1.4.2`) throw failure("PRECONDITION_FAILED");
      if (demo.conflict || installed.has(instanceKey(demo.ghostId))) throw failure("ALREADY_EXISTS");
      operations.set(operationId, { kind: "install", ghostId: demo.ghostId, answered: demo.outcome === "uncertain", polls: 2 });
      // Simulate a reply lost after the Host accepted the install; Check result reads the original operation.
      if (demo.outcome === "uncertain") throw failure("TIMEOUT");
      return result({ operationId, phase: "running" });
    }
    case "management:operation": return result(receipt(String(input.operationId)));
    case "management:answer": {
      const op = operations.get(String(input.operationId));
      if (!op) throw failure("NOT_FOUND");
      if (input.confirmed !== true) op.done = "cancelled"; else { op.answered = true; op.polls = 0; }
      return result({ operationId: String(input.operationId), phase: op.done ?? "running" });
    }
    case "management:cancel": {
      const op = operations.get(String(input.operationId));
      if (op && !op.done) op.done = "cancelled";
      return result({ operationId: String(input.operationId), phase: op?.done ?? "cancelled" });
    }
    default: return undefined;
  }
}

/** Demo plugins installed from the mock market join the installed list and detail. */
export function pluginMarketVisualInstalledItems(): RemoteCollectionItem[] {
  return [...installed].map(([key, entry]) => ({
    ref: { collectionId: PLUGIN_COLLECTION, kind: "plugin", id: key }, revision: String(entry.enabled), links: [],
    display: { title: entry.demo.name, subtitle: entry.demo.description },
    actions: [{ id: entry.enabled ? "disable" : "enable", label: entry.enabled ? "Disable" : "Enable" }],
  }));
}
export function pluginMarketVisualResource(id: string, actionId?: string): unknown {
  const entry = installed.get(id);
  if (!entry) return undefined;
  if (actionId === "enable" || actionId === "disable") {
    entry.enabled = actionId === "enable";
    return { effects: [{ kind: "refresh-collection", collectionId: PLUGIN_COLLECTION }] };
  }
  if (actionId) throw failure("UNSUPPORTED_DEMO_PLUGIN_ACTION");
  const item = pluginMarketVisualInstalledItems().find((candidate) => candidate.ref.id === id)!;
  return { ...item, blocks: [{ id: "capabilities", primitive: "plugin-capabilities", fallbackMarkdown: "",
    data: { tools: entry.demo.tools.map((name) => ({ name, description: "Example capability" })) } }] };
}

/** The mock computer also declares plugin management, next to the teammate collections it already lists. */
export function withPluginManagementManifest<T>(manifest: T): T {
  const value = manifest as { collections?: Array<{ id: string }> };
  if (!Array.isArray(value?.collections) || value.collections.some((collection) => collection.id === PLUGIN_COLLECTION)) return manifest;
  return { ...value, collections: [...value.collections, { id: PLUGIN_COLLECTION, resourceKind: "plugin", title: "Plugins",
    actions: [{ id: "management:snapshot", label: "Manage" }] }] } as T;
}
