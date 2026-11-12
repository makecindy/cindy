import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { providerCatalogForPi } from "../providerModelCatalog.js";
const piCatalog = providerCatalogForPi();

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("Pi catalog sync upstream precedence", () => {
  it.each((["input", "online"] as const).flatMap(source =>
    (["complete", "failed", "omitted"] as const).map(state => ({ source, state }))))(
    "preserves catalog metadata through the $source sync path ($state)",
    ({ source, state }) => {
      const temporary = mkdtempSync(
        path.join(tmpdir(), "cindy-pi-catalog-sync #-"),
      );
      try {
        const catalogDirectory = path.join(
          temporary,
          "packages/model-providers/catalog",
        );
        mkdirSync(catalogDirectory, { recursive: true });
        const sharedDirectory = path.join(temporary, 'packages/model-providers/src');
        mkdirSync(sharedDirectory, { recursive: true });
        cpSync(path.join(root, 'packages/model-providers/src/piThinkingLevels.mjs'),
          path.join(sharedDirectory, 'piThinkingLevels.mjs'));
        cpSync(path.join(root, 'packages/model-providers/catalog/provider-models.json'), path.join(catalogDirectory, 'provider-models.json'));
        const scriptsDirectory = path.join(temporary, "tools/pi");
        mkdirSync(scriptsDirectory, { recursive: true });
        for (const script of [
          "sync-model-catalog.mjs",
          "catalog-format.mjs",
          "openai-catalog-corrections.mjs",
          "xai-catalog-corrections.mjs",
        ]) {
          cpSync(
            path.join(root, "tools/pi", script),
            path.join(scriptsDirectory, script),
          );
        }
        cpSync(
          path.join(root, "packages/model-providers/catalog/providers.json"),
          path.join(catalogDirectory, "providers.json"),
        );
        const native = {
          ...piCatalog.providers.openai.find(model => model.id === 'gpt-6-astra')!,
          name: "Native Astra",
          contextWindow: 1_060_000,
          compat: { supportsStore: false },
          upstreamField: "preserve-native-metadata",
        };
        const input: Record<string, unknown> = { ...piCatalog.providers, openai: [native],
          'new-provider': [{ ...native, id: 'future-model', provider: 'new-provider' }],
          'partial-provider': [null, { ...native, id: 'partial-new', provider: 'partial-provider' }],
        };
        const snapshotPath = path.join(catalogDirectory, 'provider-models.json');
        const oldSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        const oldRow = oldSnapshot.providers.openai[0];
        oldSnapshot.providers['new-provider'] = [{ ...oldRow, id: 'retired-model' }];
        oldSnapshot.providers['partial-provider'] = [{ ...oldRow, id: 'partial-old' }];
        oldSnapshot.providers['offline-provider'] = [{ ...oldRow, id: 'offline-old' }];
        writeFileSync(snapshotPath, JSON.stringify(oldSnapshot));
        if (state !== "complete") for (const provider of ["xai", "openai", "openai-codex"]) {
          if (state === "failed") input[provider] = null;
          else delete input[provider];
        }
        const inputPath = path.join(temporary, "input.json");
        writeFileSync(inputPath, JSON.stringify(input));
        const args: string[] = [];
        if (source === "online") {
          const mockFetchPath = path.join(temporary, "mock-fetch.mjs");
          writeFileSync(
            mockFetchPath,
            `
            import { readFileSync } from 'node:fs';
            const providers = JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8'));
            globalThis.fetch = async (url) => {
              const provider = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
              if (provider === 'providers') return new Response(JSON.stringify([...Object.keys(providers), 'offline-provider']));
              if (provider === 'offline-provider') throw new Error('Offline source');
              if (!(provider in providers)) throw new Error('Unexpected provider: ' + provider);
              if (providers[provider] === null) return new Response("Unavailable", { status: 503 });
              return new Response(JSON.stringify(providers[provider]));
            };
          `,
          );
          args.push("--import", pathToFileURL(mockFetchPath).href);
        }
        args.push(path.join(temporary, "tools/pi/sync-model-catalog.mjs"));
        if (source === "input") args.push("--input", inputPath);
        args.push("--generated-at", "2026-09-04T21:38:48Z");
        execFileSync(process.execPath, args, {
          cwd: temporary,
          timeout: 10_000,
        });
        const result = JSON.parse(
          readFileSync(
            path.join(catalogDirectory, "provider-models.json"),
            "utf8",
          ),
        );
        expect(result.providers['new-provider'][0]).toMatchObject({ id: 'future-model', contextWindow: 1_060_000 });
        expect(result.providers['new-provider']).toHaveLength(1);
        expect(result.providers['partial-provider'].map((row: { id: string }) => row.id)).toEqual(['partial-new', 'partial-old']);
        expect(result.providers['offline-provider'].map((row: { id: string }) => row.id)).toEqual(['offline-old']);
        if (state === "complete") expect(result.providers.openai.find((row: { id: string }) => row.id === native.id)).toMatchObject({ id: native.id, name: "Native Astra", contextWindow: 1_060_000, execution: { pi: { compat: { supportsStore: false } } } });
        if (state !== "complete") for (const provider of ["xai", "openai", "openai-codex"]) {
          expect(result.providers[provider]).toEqual(expect.arrayContaining(oldSnapshot.providers[provider]));
        }
        expect(result.providers["openai-codex"].map((m: { id: string }) => m.id).sort()).toEqual(piCatalog.providers["openai-codex"]!.map(m => m.id).sort());
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});
