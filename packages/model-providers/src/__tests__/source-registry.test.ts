import { parseCatalog } from '../catalog.js';
import { EMPTY_CATALOG } from '../builtin.js';
import { BUNDLED_CATALOG } from '../../test/catalog-fixture.js';
/**
 * source（目录加载/兜底/合并）与 registry（可见性/来源/路由解析）的纯逻辑测试。
 *
 * 2026-07-19 统一重构后:bundled 的 anthropic/openai/xd 是动态清单供应商(零静态模型),
 * registry / resolveRoute 的行为测试统一在「运行时注入后的目录」fixture 上进行
 * (与生产一致:active-catalog 把 SDK 发现 / codex 注册表 / 网关下发注入后再 buildRegistry)。
 */

import { describe, it, expect, vi } from "vitest";
import { modelRegistryCanonicalJson } from "../modelRegistryCanonical.js";


import {
  loadCatalog,
  loadCatalogWithSource,
  resolveCatalogUrl,
  type CatalogIO,
} from "../source.js";
import {
  buildRegistry,
  providersForAgent,
  connectedProvidersForAgent,
  providerOffersModel,
  getModel,
  sourcesForModel,
  chatEligibleSourcesForModel,
  effectiveSourceIdForModel,
  resolveRoute,
} from "../registry.js";
import type { Catalog, CatalogModel, Provider } from "../types.js";

const MINIMAL: Catalog = {
  version: "test",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "builtin",
      agents: ["claude-code"],
      auth: { method: "oauth" },
      routing: {
        "claude-code": {
          upstream: "https://api.anthropic.com",
          authStrategy: "oauth-passthrough",
        },
      },
      models: {
        "claude-code": [
          {
            id: "claude-opus-4-8",
            name: "Opus 4.8",
            contextWindow: 1_000_000,
            efforts: ["high"],
            defaultEffort: "high",
          },
        ],
      },
    },
  ],
};

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    ...extra,
  };
}

/** 模拟生产形态:动态清单注入后的目录(active-catalog 合并结果的等价物)。 */
function runtimeCatalog(): Catalog {
  const clone = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  for (const p of clone.providers) {
    if (p.id === "anthropic") {
      const models = [
        model("claude-opus-4-8", {
          name: "Opus 4.8",
          contextWindow: 1_000_000,
        }),
      ];
      p.models["claude-code"] = models;
      p.models.codex = models;
    }
    if (p.id === "openai") {
      p.models.codex = [model("gpt-5.5", { name: "GPT-5.5" })];
      p.models["claude-code"] = [model("chatgpt/gpt-5.5", { name: "GPT-5.5" })];
    }
    if (p.id === "xd") {
      p.models["claude-code"] = [
        model("claude-opus-4-8", {
          name: "Opus 4.8",
          contextWindow: 1_000_000,
        }),
        model("gpt-5.5", { name: "GPT-5.5" }),
      ];
      p.models.codex = [model("gpt-5.5", { name: "GPT-5.5" })];
    }
  }
  return clone;
}

describe("resolveCatalogUrl", () => {
  it("negotiates only the existing API and leaves explicit files and OSS URLs intact", () => {
    expect(resolveCatalogUrl({ url: "https://api.example.test/api/model-catalog/catalog?extra=yes&registrySchemaVersion=2" }))
      .toBe("https://api.example.test/api/model-catalog/catalog?extra=yes&registrySchemaVersion=5&catalogCapabilities=server-managed-catalog");
    expect(resolveCatalogUrl({ url: "https://cdn.example.test/cfg/providers.json?version=1" }))
      .toBe("https://cdn.example.test/cfg/providers.json?version=1");
  });
  it("prefers explicit url", () => {
    expect(
      resolveCatalogUrl({ url: "https://x/y.json", baseUrl: "https://b" }),
    ).toBe("https://x/y.json");
  });
  it("builds from baseUrl + public catalog API path", () => {
    expect(
      resolveCatalogUrl({ baseUrl: "https://model-access.example.com/" }),
    ).toBe(
      "https://model-access.example.com/api/model-catalog/catalog?registrySchemaVersion=5&catalogCapabilities=server-managed-catalog",
    );
  });
  it("returns null when neither given", () => {
    expect(resolveCatalogUrl({})).toBeNull();
  });
});

describe("catalog capability cache migration", () => {
  const baseUrl = "https://catalog.example.test";
  const modern = baseUrl + "/api/model-catalog/catalog?registrySchemaVersion=5&catalogCapabilities=server-managed-catalog";
  const previousQueries = [
    "registrySchemaVersion=5&catalogCapabilities=registry-v4-media",
    "registrySchemaVersion=5",
    "registrySchemaVersion=4&catalogCapabilities=registry-v4-media",
    "registrySchemaVersion=4",
  ];
  it.each([false, true])('selects the newest complete same-source cache across all valid scopes (online=%s)', async online => {
    const snapshot = (version: string, day: number) => ({ ...MINIMAL, version, modelRegistry: {
      schemaVersion: 4, updatedAt: `2099-01-${String(day).padStart(2, '0')}T00:00:00.000Z`, models: [],
    } });
    const scopes = [modern, ...previousQueries.map(query => baseUrl + '/api/model-catalog/catalog?' + query)];
    for (const newestScope of scopes) {
      const readCache = vi.fn(async (scope: string) => JSON.stringify(snapshot(scope === newestScope ? 'newest' : 'old', scope === newestScope ? 3 : 1)));
      const writeCache = vi.fn();
      const result = await loadCatalogWithSource({ baseUrl }, {
        fetchText: async () => { if (!online) throw new Error('offline'); return JSON.stringify(snapshot('remote', 2)); },
        readCache, writeCache,
      });
      expect(result.catalog.version).toBe('newest');
      expect(new Set(readCache.mock.calls.map(([scope]) => scope))).toEqual(new Set(scopes));
      if (online) {
        expect(writeCache).toHaveBeenCalledOnce();
        expect(writeCache.mock.calls[0][0]).toBe(modern);
        expect(JSON.parse(writeCache.mock.calls[0][1]).version).toBe('newest');
      } else expect(writeCache).not.toHaveBeenCalled();
    }
  });
  it.each(previousQueries)("reads the old %s scope after upgrade while offline, without writing or deleting it", async (query) => {
    const legacy = baseUrl + "/api/model-catalog/catalog?" + query;
    const readCache = vi.fn(async (scope: string) => scope === legacy ? JSON.stringify(MINIMAL) : null);
    const writeCache = vi.fn();
    const result = await loadCatalogWithSource({ baseUrl }, {
      fetchText: async () => { throw new Error("offline"); }, readCache, writeCache,
    });
    expect(result.source).toBe("cache");
    expect(readCache.mock.calls.map(call => call[0])).toEqual([
      modern,
      ...previousQueries
        .map(previous => baseUrl + "/api/model-catalog/catalog?" + previous),
    ]);
    expect(writeCache).not.toHaveBeenCalled();
  });
  it.each(['invalid-json', 'invalid-schema', 'read-error'])("skips a corrupt current and intermediate cache (%s) and reads the next valid same-source snapshot", async failure => {
    const readCache = vi.fn(async (scope: string) => {
      if (scope.endsWith('registrySchemaVersion=4')) return JSON.stringify(MINIMAL);
      if (failure === 'read-error') throw new Error('unreadable');
      return failure === 'invalid-json' ? '{broken' : JSON.stringify({ version: 'bad', providers: 'invalid' });
    });
    const result = await loadCatalogWithSource({ baseUrl }, {
      fetchText: async () => { throw new Error('offline'); }, readCache,
    });
    expect(result.source).toBe('cache');
    expect(result.catalog.version).toBe('test');
    expect(readCache.mock.calls.every(([scope]) => scope.startsWith(baseUrl + '/api/model-catalog/catalog?'))).toBe(true);
  });
  it("prefers the capable scope and writes successful responses only to that scope", async () => {
    const readCache = vi.fn(async (scope: string) => scope === modern ? JSON.stringify(MINIMAL) : null);
    await loadCatalogWithSource({ baseUrl }, { fetchText: async () => { throw new Error("offline"); }, readCache });
    expect(readCache).toHaveBeenCalledTimes(5);
    const writeCache = vi.fn(async () => undefined);
    await loadCatalogWithSource({ baseUrl }, { fetchText: async () => JSON.stringify(MINIMAL), readCache: async () => null, writeCache });
    expect(writeCache).toHaveBeenCalledWith(modern, expect.any(String));
  });
  it.each(previousQueries)("accepts the current projection at the same revision as %s", async (query) => {
    const registry: NonNullable<Catalog['modelRegistry']> = {
      schemaVersion: 5, updatedAt: '2099-01-01T00:00:00.000Z', models: [],
      baseModels: [{ id: 'media', aliases: [], defaults: { mode: 'image_generation' } }],
    };
    const remote = { ...MINIMAL, version: 'current-projection', modelRegistry: registry };
    const cached = { ...MINIMAL, version: 'previous-projection', modelRegistry: {
      ...registry, schemaVersion: query.startsWith('registrySchemaVersion=4') ? 4 : 5,
      baseModels: [{ id: 'media', aliases: [], defaults: {} }],
    } };
    const result = await loadCatalogWithSource({ baseUrl }, {
      fetchText: async () => JSON.stringify(remote),
      readCache: async scope => scope === baseUrl + '/api/model-catalog/catalog?' + query ? JSON.stringify(cached) : null,
    });
    expect(result.authorityCatalog?.version).toBe('current-projection');
    expect(result.catalog.modelRegistry).toEqual(registry);
  });
  it('preserves a strictly newer previous projection during upgrade', async () => {
    const remote = { ...MINIMAL, modelRegistry: { schemaVersion: 5, updatedAt: '2099-01-01T00:00:00.000Z', models: [] } };
    const cached = { ...MINIMAL, version: 'newer-cache', modelRegistry: { schemaVersion: 4, updatedAt: '2099-02-01T00:00:00.000Z', models: [] } };
    const result = await loadCatalogWithSource({ baseUrl }, {
      fetchText: async () => JSON.stringify(remote),
      readCache: async scope => scope.endsWith('registrySchemaVersion=4') ? JSON.stringify(cached) : null,
    });
    expect(result.authorityCatalog?.version).toBe('newer-cache');
  });
});

describe("loadCatalog", () => {
  it("reports whether local, remote, or bundled supplied the snapshot", async () => {
    const local = await loadCatalogWithSource(
      { localPath: "/repo/providers.json" },
      { readFile: vi.fn(async () => JSON.stringify(MINIMAL)) },
    );
    const remote = await loadCatalogWithSource(
      { url: "https://catalog.example.test/providers.json" },
      { fetchText: vi.fn(async () => JSON.stringify(MINIMAL)) },
    );
    const bundled = await loadCatalogWithSource(
      { url: "https://catalog.example.test/providers.json" },
      {
        fetchText: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    );

    expect(local).toMatchObject({
      source: "local",
      capabilityEvidence: "current",
      unverifiedXdMediaKinds: ["image", "video", "embedding"],
      catalog: { version: "test" },
      authorityCatalog: { version: "test" },
    });
    expect(remote).toMatchObject({
      source: "remote",
      capabilityEvidence: "current",
      unverifiedXdMediaKinds: ["image", "video", "embedding"],
      catalog: { version: "test" },
      authorityCatalog: { version: "test" },
    });
    expect(bundled).toEqual({
      source: "empty",
      capabilityEvidence: "fallback",
      unverifiedXdMediaKinds: ["image", "video", "embedding"],
      catalog: EMPTY_CATALOG,
      authorityCatalog: null,
    });
  });

  it.each(['local', 'remote', 'cache'] as const)('preserves complete server intent from %s without adding providers, templates or Pi runtimes', async (source) => {
    const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'deepseek')!);
    delete preset.runtimes.pi;
    const input = { ...MINIMAL, presets: [preset] };
    const text = JSON.stringify(input);
    const loaded = await loadCatalogWithSource(source === 'local' ? { localPath: '/fixture' } : { url: 'https://catalog.example.test/catalog' }, {
      readFile: async () => text,
      fetchText: async () => { if (source === 'cache') throw new Error('offline'); return text; },
      readCache: async () => source === 'cache' ? text : null,
    });
    expect(loaded.catalog).toEqual(parseCatalog(structuredClone(input)));
    expect(loaded.catalog.providers.map(p => p.id)).toEqual(input.providers.map(p => p.id));
    expect(loaded.catalog.presets).toHaveLength(1);
    expect(loaded.catalog.presets![0].runtimes.pi).toBeUndefined();
    expect(loaded.catalog.modelRegistry).toBeUndefined();
  });

  it('keeps explicit empty server lists even when a previous publication had entries', async () => {
    const input = { ...MINIMAL, presets: [] };
    const loaded = await loadCatalog({ url: 'https://catalog.example.test/catalog' }, { fetchText: async () => JSON.stringify(input) });
    expect(loaded.presets ?? []).toEqual([]);
    expect(loaded.providers).toEqual(parseCatalog(MINIMAL).providers);
  });

  it("persists a valid remote snapshot and uses its source-scoped LKG after failure", async () => {
    const url = "https://catalog.example.test/providers.json";
    const writeCache = vi.fn(
      async (_scope: string, _text: string) => undefined,
    );
    const remote = await loadCatalogWithSource(
      { url },
      {
        fetchText: vi.fn(async () => JSON.stringify(MINIMAL)),
        writeCache,
      },
    );
    expect(remote.source).toBe("remote");
    expect(writeCache).toHaveBeenCalledWith(url, JSON.stringify(MINIMAL));

    const cached = await loadCatalogWithSource(
      { url },
      {
        fetchText: vi.fn(async () => {
          throw new Error("offline");
        }),
        readCache: vi.fn(async (scope) =>
          scope === url ? JSON.stringify(MINIMAL) : null,
        ),
      },
    );
    expect(cached).toMatchObject({
      source: "cache",
      catalog: { version: "test" },
    });
    expect(cached.capabilityEvidence).toBe("fallback");
  });

  it("keeps a newer cached modelRegistry when a valid remote Catalog is stale", async () => {
    const url = "https://catalog.example.test/providers.json";
    const newerUpdatedAt = "2099-08-02T00:00:00.000Z";
    const registry = JSON.parse(JSON.stringify(BUNDLED_CATALOG.modelRegistry));
    const xai = BUNDLED_CATALOG.providers.find(
      (provider) => provider.id === "xai",
    );
    if (!xai) throw new Error("missing bundled xAI provider");
    const older: Catalog = {
      ...MINIMAL,
      providers: [...MINIMAL.providers, { ...xai, name: "STALE-XAI" }],
      modelRegistry: {
        ...registry,
        updatedAt: "2026-07-30T00:00:00.000Z",
        models: registry.models.map((entry: { id: string }) =>
          entry.id === "openai/gpt-5.6-sol"
            ? { ...entry, name: "STALE" }
            : entry,
        ),
      },
    };
    const newer: Catalog = {
      ...MINIMAL,
      providers: [...MINIMAL.providers, { ...xai, name: "NEWER-LKG-XAI" }],
      modelRegistry: {
        ...registry,
        updatedAt: newerUpdatedAt,
        models: registry.models.map((entry: { id: string }) =>
          entry.id === "openai/gpt-5.6-sol"
            ? { ...entry, name: "NEWER-LKG" }
            : entry,
        ),
      },
    };
    const writeCache = vi.fn(
      async (_scope: string, _text: string) => undefined,
    );

    const loaded = await loadCatalogWithSource(
      { url },
      {
        fetchText: vi.fn(async () => JSON.stringify(older)),
        readCache: vi.fn(async () => JSON.stringify(newer)),
        writeCache,
      },
    );

    expect(loaded.source).toBe("remote");
    expect(loaded.capabilityEvidence).toBe("fallback");
    expect(loaded.catalog.providers[0]?.name).toBe(MINIMAL.providers[0]?.name);
    expect(loaded.catalog.modelRegistry?.updatedAt).toBe(newerUpdatedAt);
    expect(
      loaded.catalog.modelRegistry?.models.find(
        (entry) => entry.id === "openai/gpt-5.6-sol",
      )?.name,
    ).toBe("NEWER-LKG");
    expect(
      loaded.catalog.providers.find((provider) => provider.id === "xai")?.name,
    ).toBe("NEWER-LKG-XAI");
    const persisted = JSON.parse(writeCache.mock.calls[0]![1]);
    expect(persisted.modelRegistry.updatedAt).toBe(newerUpdatedAt);
    expect(
      persisted.providers.find((provider: Provider) => provider.id === "xai")
        ?.name,
    ).toBe("NEWER-LKG-XAI");
  });

  it("rejects a remote registry that republishes the same updatedAt with different content (keeps LKG)", async () => {
    const url = "https://catalog.example.test/providers.json";
    const registry = JSON.parse(JSON.stringify(BUNDLED_CATALOG.modelRegistry));
    const updatedAt = "2026-08-01T00:00:00.000Z";
    const cached: Catalog = {
      ...MINIMAL,
      modelRegistry: { ...registry, updatedAt },
    };
    // 同 updatedAt、内容被悄悄改写 = 非法重发(纠错必须 forward-fix 抬 updatedAt)。
    const mutatedRemote: Catalog = {
      ...MINIMAL,
      modelRegistry: {
        ...registry,
        updatedAt,
        models: registry.models.slice(1),
      },
    };
    const warns: string[] = [];

    const loaded = await loadCatalogWithSource(
      { url },
      {
        fetchText: vi.fn(async () => JSON.stringify(mutatedRemote)),
        readCache: vi.fn(async () => JSON.stringify(cached)),
        writeCache: vi.fn(async () => undefined),
        log: (level, msg) => {
          if (level === "warn") warns.push(msg);
        },
      },
    );

    expect(loaded.source).toBe("remote");
    expect(loaded.capabilityEvidence).toBe("fallback");
    expect(loaded.catalog.modelRegistry?.models).toHaveLength(
      registry.models.length,
    );
    expect(
      warns.some((msg) => msg.includes("republished the same updatedAt")),
    ).toBe(true);
  });

  it("adopts the newer snapshot returned by a serialized LKG commit", async () => {
    const url = "https://catalog.example.test/providers.json";
    const newerUpdatedAt = "2099-08-01T00:00:00.000Z";
    const registry = JSON.parse(JSON.stringify(BUNDLED_CATALOG.modelRegistry));
    const newer: Catalog = {
      ...MINIMAL,
      modelRegistry: {
        ...registry,
        updatedAt: newerUpdatedAt,
      },
    };
    const older: Catalog = {
      ...MINIMAL,
      modelRegistry: {
        ...registry,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    };

    const loaded = await loadCatalogWithSource(
      { url },
      {
        fetchText: vi.fn(async () => JSON.stringify(older)),
        writeCache: vi.fn(async () => JSON.stringify(newer)),
      },
    );

    expect(loaded.source).toBe("remote");
    expect(loaded.capabilityEvidence).toBe("fallback");
    expect(loaded.catalog.modelRegistry?.updatedAt).toBe(newerUpdatedAt);
  });

  it("reads LKG even when the startup network budget is zero and rejects bad cache", async () => {
    const url = "https://catalog.example.test/providers.json";
    const fetchText = vi.fn();
    const cached = await loadCatalogWithSource(
      { url, remoteBudgetMs: 0 },
      {
        fetchText,
        readCache: vi.fn(async () => JSON.stringify(MINIMAL)),
      },
    );
    expect(fetchText).not.toHaveBeenCalled();
    expect(cached.source).toBe("cache");

    const invalid = await loadCatalogWithSource(
      { url, remoteBudgetMs: 0 },
      {
        fetchText,
        readCache: vi.fn(async () => '{"version":"bad","providers":[]}'),
      },
    );
    expect(invalid).toEqual({
      source: "empty",
      capabilityEvidence: "fallback",
      unverifiedXdMediaKinds: ["image", "video", "embedding"],
      catalog: EMPTY_CATALOG,
      authorityCatalog: null,
    });
  });

  it("dev: reads local path, skips network", async () => {
    const fetchText = vi.fn();
    const io: CatalogIO = {
      readFile: vi.fn(async () => JSON.stringify(MINIMAL)),
      fetchText,
    };
    const cat = await loadCatalog({ localPath: "/repo/providers.json" }, io);
    expect(io.readFile).toHaveBeenCalledWith("/repo/providers.json");
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat.providers).toEqual(parseCatalog(MINIMAL).providers);
  });

  it('never fetches retired OSS configuration, including when the server fails or returns invalid data', async () => {
    for (const response of [null, '{"invalid":true}']) {
      const fetchText = vi.fn(async (_url: string, _timeout: number) => { if (response === null) throw new Error('offline'); return response; });
      const result = await loadCatalogWithSource({ baseUrl: 'https://catalog.example.test', fallbackBaseUrl: 'https://retired.example.test' }, { fetchText });
      expect(result.source).toBe('empty');
      expect(result.catalog).toEqual(EMPTY_CATALOG);
      expect(fetchText).toHaveBeenCalledTimes(1);
      expect(fetchText.mock.calls[0][0]).toContain('/api/model-catalog/catalog');
    }
  });

  it("redacts credentials, query, and hash from remote URL diagnostics", async () => {
    const remoteUrl =
      "https://catalog-user:catalog-pass@override.example.com/providers.json?token=secret-token#private";
    const log = vi.fn<NonNullable<CatalogIO["log"]>>();
    const fetchText = vi.fn(async (url: string) => {
      throw new Error(`request failed for ${url}`);
    });

    await loadCatalog({ url: remoteUrl, now: () => 0 }, { fetchText, log });

    expect(fetchText).toHaveBeenCalledWith(remoteUrl, 15_000);
    const diagnostics = JSON.stringify(log.mock.calls);
    expect(diagnostics).toContain(
      "https://override.example.com/providers.json",
    );
    expect(diagnostics).not.toContain("catalog-user");
    expect(diagnostics).not.toContain("catalog-pass");
    expect(diagnostics).not.toContain("secret-token");
    expect(diagnostics).not.toContain("#private");
  });

  it("returns an empty catalog when neither server nor cache is available", async () => {
    const io: CatalogIO = {
      fetchText: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const cat = await loadCatalog({ url: "https://x/y.json" }, io);
    expect(cat).toEqual(EMPTY_CATALOG);
  });

  it("disableFetch without a cache leaves catalog empty (no network)", async () => {
    const fetchText = vi.fn();
    const cat = await loadCatalog(
      { url: "https://x/y.json", disableFetch: true },
      { fetchText },
    );
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat).toEqual(EMPTY_CATALOG);
  });
});

describe("registry visibility & sources(运行时注入 fixture)", () => {
  const views = buildRegistry(runtimeCatalog(), {
    xd: true,
    anthropic: false,
    openai: false,
  });

  it("providersForAgent ignores connection", () => {
    expect(
      providersForAgent(views, "claude-code")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["anthropic", "openai", "xai", "xd"]);
    expect(
      providersForAgent(views, "codex")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["anthropic", "openai", "xai", "xd"]);
  });

  it("connectedProvidersForAgent honors connection", () => {
    expect(
      connectedProvidersForAgent(views, "claude-code").map((p) => p.id),
    ).toEqual(["xd"]);
    expect(connectedProvidersForAgent(views, "codex").map((p) => p.id)).toEqual(
      ["xd"],
    );
  });

  it("agent selectors and model sources exclude disabled runtimes", () => {
    const catalog = runtimeCatalog();
    const xd = catalog.providers.find((provider) => provider.id === "xd")!;
    xd.routing.codex = { ...xd.routing.codex!, disabled: true };
    const disabledViews = buildRegistry(catalog, { xd: true });

    expect(
      providersForAgent(disabledViews, "codex").map((provider) => provider.id),
    ).not.toContain("xd");
    expect(connectedProvidersForAgent(disabledViews, "codex")).toEqual([]);
    expect(sourcesForModel(disabledViews, "gpt-5.5", "codex")).toEqual([]);
    expect(
      connectedProvidersForAgent(disabledViews, "claude-code").map(
        (provider) => provider.id,
      ),
    ).toEqual(["xd"]);
  });

  it("agent selectors and model sources exclude a declared agent with no routing descriptor", () => {
    const catalog = runtimeCatalog();
    const xd = catalog.providers.find((provider) => provider.id === "xd")!;
    delete xd.routing.codex;
    const missingRouteViews = buildRegistry(catalog, { xd: true });

    expect(
      providersForAgent(missingRouteViews, "codex").map(
        (provider) => provider.id,
      ),
    ).not.toContain("xd");
    expect(connectedProvidersForAgent(missingRouteViews, "codex")).toEqual([]);
    expect(sourcesForModel(missingRouteViews, "gpt-5.5", "codex")).toEqual([]);
  });

  it("providerOffersModel / getModel (agent-scoped)", () => {
    const xd = views.find((p) => p.id === "xd")!;
    expect(providerOffersModel(xd, "gpt-5.5", "codex")).toBe(true);
    expect(providerOffersModel(xd, "no-such", "codex")).toBe(false);
    expect(providerOffersModel(xd, "claude-opus-4-8", "codex")).toBe(false);
    expect(getModel(xd, "claude-opus-4-8", "claude-code")?.name).toBe(
      "Opus 4.8",
    );
  });

  it("sourcesForModel: only connected providers by default", () => {
    expect(
      sourcesForModel(views, "claude-opus-4-8", "claude-code").map((p) => p.id),
    ).toEqual(["xd"]);
    expect(
      sourcesForModel(views, "claude-opus-4-8", "claude-code", {
        onlyConnected: false,
      })
        .map((p) => p.id)
        .sort(),
    ).toEqual(["anthropic", "xd"]);
  });

  it("sourcesForModel: same model two sources when both connected", () => {
    const all = buildRegistry(runtimeCatalog(), {
      xd: true,
      anthropic: true,
      openai: true,
      xai: true,
    });
    expect(
      sourcesForModel(all, "gpt-5.5", "codex")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["openai", "xd"]);
    expect(
      sourcesForModel(all, "gpt-5.5", "claude-code").map((p) => p.id),
    ).toEqual(["xd"]);
    expect(
      sourcesForModel(all, "xai/grok-4.3", "codex").map((p) => p.id),
    ).toEqual(["xai"]);
  });

  it("effectiveSourceIdForModel 只在真正提供当前模型的已连接来源里选默认", () => {
    const openaiOnly = buildRegistry(runtimeCatalog(), {
      xd: false,
      anthropic: false,
      openai: true,
      xai: false,
    });
    expect(
      effectiveSourceIdForModel(
        openaiOnly,
        null,
        "claude-opus-4-8",
        "claude-code",
      ),
    ).toBeNull();
    expect(
      effectiveSourceIdForModel(
        openaiOnly,
        null,
        "chatgpt/gpt-5.5",
        "claude-code",
      ),
    ).toBe("openai");
  });

  it("effectiveSourceIdForModel 保留有效显式来源，失效时不替换账号", () => {
    const all = buildRegistry(runtimeCatalog(), {
      xd: true,
      anthropic: true,
      openai: true,
      xai: true,
    });
    expect(
      effectiveSourceIdForModel(
        all,
        "anthropic",
        "claude-opus-4-8",
        "claude-code",
      ),
    ).toBe("anthropic");
    expect(
      effectiveSourceIdForModel(
        all,
        "openai",
        "claude-opus-4-8",
        "claude-code",
      ),
    ).toBeNull();
  });

  it("effectiveSourceIdForModel 不把请求路由到非聊天来源(issue #882 第 3 点,2026-07 review):同一 id 在不同来源上 mode 不一致时,只信聊天来源", () => {
    const mixedModeCatalog: Catalog = {
      version: "test",
      providers: [
        {
          id: "xd",
          name: "XD",
          source: "builtin",
          agents: ["claude-code"],
          auth: { method: "managed" },
          routing: {
            "claude-code": {
              upstream: "https://xd.test",
              authStrategy: "gateway-key",
            },
          },
          models: {
            "claude-code": [model("shared-id", { mode: "image_generation" })],
          },
        },
        {
          id: "openai",
          name: "OpenAI",
          source: "builtin",
          agents: ["claude-code"],
          auth: { method: "oauth" },
          routing: {
            "claude-code": {
              upstream: "https://api.openai.com",
              authStrategy: "oauth-passthrough",
            },
          },
          models: {
            "claude-code": [model("shared-id", { mode: "chat" })],
          },
        },
      ],
    };
    const views = buildRegistry(mixedModeCatalog, { xd: true, openai: true });
    // 显式指定的来源不是聊天来源时拒绝，不改用另一个账号。
    expect(
      effectiveSourceIdForModel(views, "xd", "shared-id", "claude-code"),
    ).toBeNull();
    // 未显式指定 providerId 时,默认来源同样只能是聊天来源。
    expect(
      effectiveSourceIdForModel(views, null, "shared-id", "claude-code"),
    ).toBe("openai");

    // chatEligibleSourcesForModel 是这份过滤的共享底层——直接断言它自己的输出,
    // 保证 UI 侧的"有没有可发送来源"判断(ChatInput/useConnectedSource/
    // isSelectedSourceDisconnected)与路由解析用的是同一份口径,不会互相打架。
    expect(
      chatEligibleSourcesForModel(views, "shared-id", "claude-code").map(
        (p) => p.id,
      ),
    ).toEqual(["openai"]);
  });

  it("chatEligibleSourcesForModel 不误杀用户自定义供应商显式配置的模型(2026-07 review 第 25 轮)", () => {
    // flux-image-x 的 id 撞上 /image/ 启发式,但它来自 source:'user' 的自定义供应商且
    // group 是未知的 custom:*——isAgentSelectableModel 的 userProvider 例外有意放行
    // (用户显式配置的就是聊天模型)。裸 isChatEligible 会把它从路由/发送门禁里删掉,
    // 用户配好的模型 UI 显示"没有已连接的来源"、请求发不出去。
    const userProviderCatalog: Catalog = {
      version: "test",
      providers: [
        {
          id: "custom-p",
          name: "Custom",
          source: "user",
          agents: ["claude-code"],
          auth: { method: "apiKey" },
          routing: {
            "claude-code": {
              upstream: "https://custom.test",
              authStrategy: "api-key-header",
            },
          },
          models: {
            "claude-code": [
              model("flux-image-x", { group: "custom:custom-p" }),
            ],
          },
        },
      ],
    };
    const views = buildRegistry(userProviderCatalog, { "custom-p": true });
    expect(
      chatEligibleSourcesForModel(views, "flux-image-x", "claude-code").map(
        (p) => p.id,
      ),
    ).toEqual(["custom-p"]);
    expect(
      effectiveSourceIdForModel(
        views,
        "custom-p",
        "flux-image-x",
        "claude-code",
      ),
    ).toBe("custom-p");
  });
});

describe("resolveRoute(运行时注入 fixture)", () => {
  const views = buildRegistry(runtimeCatalog(), {
    xd: true,
    anthropic: true,
    openai: true,
    xai: true,
  });
  // xd 网关地址以内置身份卡(builtin.ts,端点单点)为准;门禁校验其与权威源一致
  const xdRouting = BUNDLED_CATALOG.providers.find(
    (prov) => prov.id === "xd",
  )?.routing;

  it("anthropic claude (claude-code) → direct upstream, oauth-passthrough", () => {
    const r = resolveRoute(
      views,
      "anthropic",
      "claude-opus-4-8",
      "claude-code",
    );
    expect(r?.routing.upstream).toBe("https://api.anthropic.com");
    expect(r?.routing.authStrategy).toBe("oauth-passthrough");
  });

  it("anthropic claude (codex) → Anthropic Messages bridge + host-owned OAuth", () => {
    const r = resolveRoute(views, "anthropic", "claude-opus-4-8", "codex");
    expect(r?.routing).toMatchObject({
      upstream: "https://api.anthropic.com",
      wireProtocol: "anthropic-messages",
      authStrategy: "provider-oauth-header",
      headerOverride: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      },
    });
  });

  it("xd claude (claude-code) → gateway, gateway-key, 不删 anthropic-beta(fast 经网关透传)", () => {
    const r = resolveRoute(views, "xd", "claude-opus-4-8", "claude-code");
    expect(r?.routing.upstream).toBe(xdRouting?.["claude-code"]?.upstream);
    expect(r?.routing.authStrategy).toBe("gateway-key");
    expect(r?.routing.headerDelete).toBeUndefined();
  });

  it("xd gpt (codex) → gateway/v1; openai gpt (codex) → chatgpt direct", () => {
    expect(
      resolveRoute(views, "xd", "gpt-5.5", "codex")?.routing.upstream,
    ).toBe(xdRouting?.codex?.upstream);
    const oa = resolveRoute(views, "openai", "gpt-5.5", "codex");
    expect(oa?.routing.upstream).toBe("https://chatgpt.com/backend-api/codex");
    expect(oa?.routing.authStrategy).toBe("oauth-passthrough");
  });

  it("xai grok (codex) → api.x.ai/v1 with provider OAuth token and xai/ model rewrite", () => {
    const r = resolveRoute(views, "xai", "xai/grok-4.3", "codex");
    expect(r?.routing.upstream).toBe("https://api.x.ai/v1");
    expect(r?.routing.authStrategy).toBe("provider-oauth-header");
    expect(r?.routing.modelIdRewrite).toEqual({ stripPrefix: "xai/" });
  });

  it("rejects unsupported (provider, model, agent) combos", () => {
    expect(
      resolveRoute(views, "anthropic", "gpt-5.5", "claude-code"),
    ).toBeNull();
    expect(
      resolveRoute(views, "openai", "claude-opus-4-8", "codex"),
    ).toBeNull();
    expect(
      resolveRoute(views, "nope", "claude-opus-4-8", "claude-code"),
    ).toBeNull();
  });

  it("rejects a disabled route even when provider, model, and agent match", () => {
    const disabledViews = views.map((provider) =>
      provider.id === "xai"
        ? {
            ...provider,
            routing: {
              ...provider.routing,
              codex: { ...provider.routing.codex!, disabled: true },
            },
          }
        : provider,
    );
    expect(
      resolveRoute(disabledViews, "xai", "xai/grok-4.3", "codex"),
    ).toBeNull();
  });

  it("动态供应商未注入清单时不解析路由(无可用性证明不路由)", () => {
    const bare = buildRegistry(BUNDLED_CATALOG, {
      xd: true,
      anthropic: true,
      openai: true,
      xai: true,
    });
    expect(
      resolveRoute(bare, "anthropic", "claude-opus-4-8", "claude-code"),
    ).toBeNull();
    expect(resolveRoute(bare, "xd", "gpt-5.5", "codex")).toBeNull();
    expect(
      resolveRoute(bare, "xai", "xai/grok-4.3", "codex")?.routing.upstream,
    ).toBe("https://api.x.ai/v1");
  });
});

describe("server-delivered local models", () => {
  it("accepts later V4 updates and preserves an explicit empty recommendation through offline fallback", async () => {
    const snapshot = {
      ...MINIMAL,
      modelRegistry: {
        schemaVersion: 4,
        updatedAt: "2099-01-01T00:00:00.000Z",
        models: [],
        localModels: { version: 1, models: [], featuredIds: [] },
      },
    };
    let cached: string | null = null;
    const cfg = { baseUrl: "https://model-access.example.com" };
    const io: CatalogIO = {
      fetchText: async () => JSON.stringify(snapshot),
      readCache: async () => cached,
      writeCache: async (_scope, text) => {
        cached = text;
      },
    };
    const remote = await loadCatalogWithSource(cfg, io);
    expect(remote.catalog.modelRegistry?.localModels).toEqual(
      snapshot.modelRegistry.localModels,
    );
    const offline = await loadCatalogWithSource(cfg, {
      ...io,
      fetchText: async () => {
        throw new Error("offline");
      },
    });
    expect(offline.source).toBe("cache");
    expect(offline.catalog.modelRegistry?.localModels?.featuredIds).toEqual([]);
    const invalid = structuredClone(snapshot);
    invalid.modelRegistry.localModels.featuredIds = ["missing"] as never[];
    const rejected = await loadCatalogWithSource(cfg, {
      ...io,
      fetchText: async () => JSON.stringify(invalid),
    });
    expect(rejected.catalog.modelRegistry?.localModels).toEqual(
      snapshot.modelRegistry.localModels,
    );
    expect(JSON.parse(cached!).modelRegistry.localModels.featuredIds).toEqual(
      [],
    );
    const conflict = structuredClone(snapshot);
    delete (conflict.modelRegistry as { localModels?: unknown }).localModels;
    const retained = await loadCatalogWithSource(cfg, {
      ...io,
      fetchText: async () => JSON.stringify(conflict),
    });
    expect(retained.catalog.modelRegistry?.localModels).toEqual(
      snapshot.modelRegistry.localModels,
    );
  });
});
