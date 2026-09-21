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
} from "./xai-catalog-corrections.mjs";
import {
  applyAstraCatalogAdditions,
  applyPinnedAstraCorrections,
} from "./openai-catalog-corrections.mjs";
function catalogEntries(providerId, value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.models)
      ? value.models
      : value && typeof value === "object"
        ? Object.values(value)
        : null;
  if (!entries)
    throw new Error(`Pi catalog '${providerId}' is not an array or model map`);
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error(`Pi catalog '${providerId}' contains an invalid model`);
    }
    if (entry.provider !== providerId) {
      throw new Error(
        `Pi catalog '${providerId}' model '${entry.id}' has provider '${entry.provider}'`,
      );
    }
    return entry;
  });
}

async function main() {
  const providers = {};
  const previous = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
  const PROVIDER_IDS = Object.keys(previous.providers).filter(id => id !== '.manifest').sort();
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
    for (const providerId of PROVIDER_IDS) {
      if (!(providerId in input))
        throw new Error(`Input catalog lacks provider '${providerId}'`);
    }
    for (const providerId of Object.keys(input)) {
      if (providerId === '.manifest') continue;
      if (!(providerId in input))
        throw new Error(`Input catalog lacks provider '${providerId}'`);
      providers[providerId] = catalogEntries(providerId, input[providerId]);
    }
  } else {
    // Refresh the complete imported catalog, including channels not curated as GUI presets.
    const providerIds = [
      ...new Set(PROVIDER_IDS),
    ].sort();
    for (const providerId of providerIds) {
      const response = await fetch(
        `${PI_CATALOG_BASE}/${encodeURIComponent(providerId)}`,
        {
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
      providers[providerId] = catalogEntries(providerId, await response.json());
    }
  }
  if (providers.xai) providers.xai = applyKnownXaiCorrections(providers.xai);
  applyAstraCatalogAdditions(providers);
  if (bundlePath) {
    applyPinnedAstraCorrections(providers, sourceVersion);
    applyPinnedXaiAdditions(providers, sourceVersion);
  }

  const generatedAt = generatedAtArg
    ? new Date(generatedAtArg).toISOString()
    : new Date(newestModified || Date.now()).toISOString();
  const standard = {
    ...toCindyCatalog(providers, generatedAt),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
  // Conversion completes before replacing the last good catalog.
  const modelText = `${JSON.stringify(standard, null, 2)}\n`;
  await fs.writeFile(SNAPSHOT_PATH, modelText);
  console.log(
    `Synced ${Object.keys(providers).length} Pi providers at ${generatedAt}`,
  );
}

await main();
