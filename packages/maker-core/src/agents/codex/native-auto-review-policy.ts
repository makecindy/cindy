import defaultPolicy from "./native-auto-review-policy-0.145.0.md?raw";
import currentPolicy from "./native-auto-review-policy-0.153.4.md?raw";
import { AUTO_REVIEW_CONTINUATION_POLICY } from "../shared/continuation-policy.js";

/** Complete default policies captured from stock Codex 0.145.0 and 0.153.4
 * reviewer requests. Only those exact stable runtimes are covered: a new native
 * version must be checked against its own full policy before adding support.
 * Native built-in evidence/risk/output instructions remain owned by Codex.
 * auto_review.policy is inline Markdown, NOT a filename. Managed requirements
 * retain native precedence; an existing user/project override is never replaced.
 */
export function nativeAutoReviewContinuationConfig(
  userAgent: string | undefined,
  effectiveConfig: Record<string, unknown>,
): Record<string, unknown> {
  const version = /\/(0\.145\.0|0\.153\.4)(?:[ )]|$)/.exec(userAgent ?? "")?.[1];
  if (!version) return {};
  const policy = version === "0.153.4" ? currentPolicy : defaultPolicy;
  const autoReview = effectiveConfig.auto_review;
  if (
    autoReview !== undefined &&
    (typeof autoReview !== "object" ||
      autoReview === null ||
      Array.isArray(autoReview))
  )
    return {};
  if (autoReview && Object.hasOwn(autoReview, "policy")) return {};
  if (
    Object.hasOwn(effectiveConfig, "auto_review.policy") ||
    Object.hasOwn(effectiveConfig, "guardian_policy_config")
  )
    return {};
  return {
    "auto_review.policy": `${policy.trim()}\n\n## Scoped continuation of authorized work\n${AUTO_REVIEW_CONTINUATION_POLICY}`,
  };
}
