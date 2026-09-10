import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../catalog.js";
const root = new URL("../../fixtures/published-catalog/", import.meta.url);
const read = (file: string) =>
  JSON.parse(readFileSync(new URL(file, root), "utf8"));
const manifest = read("manifest.json") as {
  version: number;
  cases: { file: string; valid: boolean; description: string }[];
};
describe("shared published catalog contract v1", () => {
  for (const item of manifest.cases)
    it(item.description, () => {
      if (item.valid) expect(() => parseCatalog(read(item.file))).not.toThrow();
      else expect(() => parseCatalog(read(item.file))).toThrow();
    });
});
