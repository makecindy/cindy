import { describe, it, expect } from "vitest";
import { parseLocalModelCatalog } from "../localModelCatalog.js";

const gguf = {
  repo: "owner/model",
  file: "Q4/model-Q4_K_M-00001-of-00002.gguf",
  quantization: "Q4_K_M",
  sizeBytes: 1234567890,
  verifiedAt: "2026-09-25",
};
function catalog(variants: unknown = [gguf]) {
  return {
    version: 1,
    featuredIds: ["example"],
    models: [
      {
        id: "example",
        name: "Example",
        aliases: [],
        variants: [
          {
            libraryName: "example:4b",
            sizeBytes: 2 ** 31,
            minUnifiedMemoryGb: 8,
          },
        ],
        llamacpp: variants,
      },
    ],
  };
}
describe("GGUF packaging shares the model catalog", () => {
  it("accepts verified download metadata, explicit withdrawal and older catalogs", () => {
    expect(parseLocalModelCatalog(catalog())).not.toBeNull();
    expect(parseLocalModelCatalog(catalog([]))).not.toBeNull();
    expect(parseLocalModelCatalog(catalog(undefined))).not.toBeNull();
  });
  it.each([
    { repo: "https://evil.test/model" },
    { file: "../escape.gguf" },
    { file: "mmproj-model.gguf" },
    { file: "model.gguf;command" },
    { file: "/tmp/model.gguf" },
    { sizeBytes: -1 },
    { sizeBytes: NaN },
    { quantization: "--command" },
    { verifiedAt: "2026-02-30" },
    { command: "run something" },
  ])("rejects unsafe or invalid packaging %j", (patch) => {
    expect(parseLocalModelCatalog(catalog([{ ...gguf, ...patch }]))).toBeNull();
  });
  it("rejects duplicate and excessive packages", () => {
    expect(parseLocalModelCatalog(catalog([gguf, gguf]))).toBeNull();
    expect(parseLocalModelCatalog(catalog(Array(9).fill(gguf)))).toBeNull();
  });
});
