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

import piCatalog from "../../catalog/pi-model-catalog.json";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("Pi catalog sync upstream precedence", () => {
  it.each(["input", "online"] as const)(
    "reads native public API Astra metadata through the %s sync path",
    (source) => {
      const temporary = mkdtempSync(
        path.join(tmpdir(), "cindy-pi-catalog-sync #-"),
      );
      try {
        const catalogDirectory = path.join(
          temporary,
          "packages/model-providers/catalog",
        );
        mkdirSync(catalogDirectory, { recursive: true });
        const scriptsDirectory = path.join(temporary, "tools/pi");
        mkdirSync(scriptsDirectory, { recursive: true });
        for (const script of [
          "sync-model-catalog.mjs",
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
          ...piCatalog.providers.openai[0],
          name: "Native Astra",
          contextWindow: 1_060_000,
          compat: { supportsStore: false },
          upstreamField: "preserve-native-metadata",
        };
        const input = { ...piCatalog.providers, openai: [native] };
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
              if (!(provider in providers)) throw new Error('Unexpected provider: ' + provider);
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
            path.join(catalogDirectory, "pi-model-catalog.json"),
            "utf8",
          ),
        );
        expect(result.providers.openai).toEqual([native]);
        expect(result.providers["openai-codex"]).toEqual(input["openai-codex"]);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});
