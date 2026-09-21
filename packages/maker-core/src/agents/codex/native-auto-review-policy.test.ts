import { describe, expect, it } from "vitest";
import defaultPolicy from "./native-auto-review-policy-0.145.0.md?raw";
import currentPolicy from "./native-auto-review-policy-0.153.4.md?raw";
import { AUTO_REVIEW_CONTINUATION_POLICY } from "../shared/continuation-policy.js";
import { nativeAutoReviewContinuationConfig } from "./native-auto-review-policy.js";

describe("native auto-review continuation configuration", () => {
  it("uses the current packaged runtime's own complete policy", () => {
    expect(nativeAutoReviewContinuationConfig("cindy/0.153.4 (macOS)", {})["auto_review.policy"])
      .toBe(`${currentPolicy.trim()}\n\n## Scoped continuation of authorized work\n${AUTO_REVIEW_CONTINUATION_POLICY}`);
  });
  it("preserves the complete default policy and appends only scoped continuation semantics", () => {
    const config = nativeAutoReviewContinuationConfig(
      "codex_cli_rs/0.145.0 (macOS)",
      {},
    );
    expect(Object.keys(config)).toEqual(["auto_review.policy"]);
    expect(config["auto_review.policy"]).toBe(
      `${defaultPolicy.trim()}\n\n## Scoped continuation of authorized work\n${AUTO_REVIEW_CONTINUATION_POLICY}`,
    );
  });
  it.each([
    undefined,
    "unknown",
    "codex/0.144.0",
    "codex/0.145.1",
    "codex/0.145.0-alpha",
    "codex/0.153.5",
    "codex/0.153.4-alpha",
  ])(
    "never substitutes a policy copied from a different runtime: %s",
    (version) => {
      expect(nativeAutoReviewContinuationConfig(version, {})).toEqual({});
    },
  );
  it.each([
    { auto_review: { policy: "custom policy" } },
    { auto_review: { policy: "" } },
    { auto_review: null },
    { "auto_review.policy": "custom policy" },
    { guardian_policy_config: "managed policy" },
  ])(
    "retains custom/managed policy and ambiguous configuration: %j",
    (config) => {
      expect(
        nativeAutoReviewContinuationConfig("codex/0.145.0", config),
      ).toEqual({});
    },
  );
});
