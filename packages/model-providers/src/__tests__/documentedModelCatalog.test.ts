import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseModelRegistry } from "../modelAccessValidator.js";
import { resolveModelMetadata } from "../modelMetadataLayers.js";

const markdown = readFileSync(
  new URL("../../../../docs/examples/model-catalog.md", import.meta.url),
  "utf8",
);
const examples = new Map(
  [
    ...markdown.matchAll(
      /<!-- example: ([a-z-]+) -->\s*```json\s*([\s\S]*?)```/g,
    ),
  ].map((match) => [match[1], JSON.parse(match[2])]),
);
function registry(id: string) {
  expect(examples.has(id), `documented example ${id}`).toBe(true);
  const result = parseModelRegistry(examples.get(id));
  if (!result.ok) throw new Error(`${id}: ${result.error}`);
  return result.value;
}
function windowFor(id: string, live?: number, user?: number) {
  return resolveModelMetadata(
    registry(id),
    "example-provider",
    "model",
    live === undefined ? undefined : { contextWindow: live },
    user === undefined ? undefined : { contextWindow: user },
    "codex",
  ).contextWindow;
}

describe("documented model catalog examples", () => {
  it("all five Registry examples pass the production parser", () => {
    expect(examples.size).toBe(5);
    for (const id of examples.keys()) registry(id);
  });
  it("public, route and engine defaults have the described effect", () => {
    expect(windowFor("base-model")).toBe(128000);
    expect(windowFor("route-default")).toBe(64000);
    expect(windowFor("agent-default")).toBe(32000);
    expect(windowFor("route-default", 80000)).toBe(80000);
    expect(windowFor("agent-default", 80000)).toBe(80000);
  });
  it("a justified correction overrides live metadata but not user settings", () => {
    expect(windowFor("forced-correction", 80000)).toBe(72000);
    expect(windowFor("forced-correction", 80000, 16000)).toBe(16000);
  });
  it("the local example retains the candidate and explicit empty recommendations", () => {
    const local = registry("local-candidate").localModels!;
    expect(local.models.map((model) => model.id)).toEqual(["example-local"]);
    expect(local.featuredIds).toEqual([]);
  });
});
