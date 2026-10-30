#!/usr/bin/env node

import fs from "node:fs/promises";
import { toCindyCatalog } from "./catalog-format.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SNAPSHOT_PATH = path.join(
  ROOT,
  "packages/model-providers/catalog/provider-models.json",
);
const PI_CATALOG_BASE = "https://pi.dev/api/models/providers";

import {
  applyKnownXaiCorrections,
  applyPinnedXaiAdditions,
  applyGrok47CatalogAddition,
} from "./xai-catalog-corrections.mjs";
import {
  applyAstraCatalogAdditions,
  applyPinnedAstraCorrections,
} from "./openai-catalog-corrections.mjs";
function catalogEntries(providerId, value, incompleteProviders) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.models)
      ? value.models
      : value && typeof value === "object"
        ? Object.values(value)
        : null;
  if (!entries)
    throw new Error(`Pi catalog '${providerId}' is not an array or model map`);
  return entries.filter((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.provider !== providerId) {
      console.warn(`Skipping invalid model in '${providerId}'`);
      incompleteProviders.add(providerId);
      return false;
    }
    return true;
  });
}

async function main() {
  const providers = {};
  const incompleteProviders = new Set();
  const previous = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
  const PROVIDER_IDS = Object.keys(previous.providers)
    .filter((id) => id !== ".manifest")
    .sort();
  let newestModified = 0;
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
  const generatedAtIndex = process.argv.indexOf("--generated-at");
  const generatedAtArg =
    generatedAtIndex >= 0 ? process.argv[generatedAtIndex + 1] : undefined;
  const versionIndex = process.argv.indexOf("--source-version");
  const sourceVersion =
    versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined;
  const bundleIndex = process.argv.indexOf("--pi-bundle");
  const bundlePath =
    bundleIndex >= 0 ? process.argv[bundleIndex + 1] : undefined;
  if (bundlePath && !sourceVersion)
    throw new Error("--pi-bundle requires --source-version");
  if (inputPath && bundlePath) throw new Error("Choose --input or --pi-bundle");
  if (inputPath || bundlePath) {
    const input = bundlePath
      ? (await import("./read-bundled-catalog.mjs")).readBundledCatalog(
          await fs.readFile(path.resolve(bundlePath), "utf8"),
        )
      : JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"));
    for (const providerId of Object.keys(input)) {
      if (providerId === ".manifest") continue;
      try { providers[providerId] = catalogEntries(providerId, input[providerId], incompleteProviders); }
      catch {
        incompleteProviders.add(providerId);
        console.warn(`Keeping previous catalog for '${providerId}': invalid source`);
      }
    }
  } else {
    // Refresh the complete imported catalog, including channels not curated as GUI presets.
    let discovered = [];
    try {
      const index = await fetch(PI_CATALOG_BASE, { signal: AbortSignal.timeout(15_000) });
      if (!index.ok) throw new Error(`HTTP ${index.status}`);
      const data = await index.json();
      if (Array.isArray(data)) discovered = data.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id));
    } catch { console.warn('Provider index unavailable; refreshing previously known providers'); }
    const providerIds = [...new Set([...PROVIDER_IDS, ...discovered])].sort();
    for (const providerId of providerIds) {
      try {
        const response = await fetch(
          `${PI_CATALOG_BASE}/${encodeURIComponent(providerId)}`,
          {
            signal: AbortSignal.timeout(15_000),
            headers: {
              accept: "application/json",
              "user-agent": "cindy-pi-catalog-sync",
            },
          },
        );
        if (!response.ok)
          throw new Error(
            `Pi catalog '${providerId}' returned HTTP ${response.status}`,
          );
        const modified = Date.parse(response.headers.get("last-modified") ?? "");
        if (!Number.isNaN(modified))
          newestModified = Math.max(newestModified, modified);
        providers[providerId] = catalogEntries(providerId, await response.json(), incompleteProviders);
      } catch {
        incompleteProviders.add(providerId);
        console.warn(`Keeping previous catalog for '${providerId}': source unavailable`);
      }
    }
  }
  // An omitted/failed source is not a complete snapshot, even if corrections
  // below create a provider containing only an additive model.
  for (const providerId of PROVIDER_IDS) {
    if (!Object.hasOwn(providers, providerId)) incompleteProviders.add(providerId);
  }
  if (providers.xai) providers.xai = applyKnownXaiCorrections(providers.xai);
  applyGrok47CatalogAddition(providers);
  applyAstraCatalogAdditions(providers);
  if (bundlePath) {
    applyPinnedAstraCorrections(providers, sourceVersion);
    applyPinnedXaiAdditions(providers, sourceVersion);
  }

  const generatedAt = generatedAtArg
    ? new Date(generatedAtArg).toISOString()
    : new Date(newestModified || Date.now()).toISOString();
  const standard = {
    ...toCindyCatalog(providers, generatedAt, { previous, incompleteProviders, onError: () => console.warn('Skipping invalid model; keeping last good record') }),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
  standard.providers = { ...previous.providers, ...standard.providers };
  // A partial upstream outage never removes the last usable model record.
  // Replace atomically so interruption cannot truncate the last good catalog.
  const modelText = `${JSON.stringify(standard, null, 2)}\n`;
  const temporary = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, modelText, { flag: 'wx' });
    await fs.rename(temporary, SNAPSHOT_PATH);
  } finally { await fs.rm(temporary, { force: true }); }
  console.log(
    `Synced ${Object.keys(providers).length} Pi providers at ${generatedAt}`,
  );
}

await main();
