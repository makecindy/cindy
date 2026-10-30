// Pure parameter/schema helpers extracted from the upstream Chat adapter.
import type { OcxProviderConfig } from "../types";
import { lookupLocalJsonPointer } from "./xai-schema-analysis";
interface OcxParsedRequest { options: { reasoning?: string } }
export function stripBracketedModelSuffix(modelId: string): string {
  const suffixEnd = modelId.trimEnd().length;
  if (suffixEnd === 0 || modelId[suffixEnd - 1] !== "]") return modelId;

  let suffixStart = -1;
  for (let i = suffixEnd - 2; i >= 0 && modelId[i] !== "]"; i--) {
    if (modelId[i] === "[") suffixStart = i;
  }
  return suffixStart === -1 ? modelId : modelId.slice(0, suffixStart);
}

export function reasoningDetailSegmentForWire(text: string): Record<string, unknown> {
  return { type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text };
}

export const MOONSHOT_SCHEMA_HOSTNAMES = new Set([
  "api.kimi.com",
  "api.moonshot.ai",
  "api.moonshot.cn",
]);

export function isMoonshotSchemaTarget(provider: OcxProviderConfig): boolean {
  try {
    return MOONSHOT_SCHEMA_HOSTNAMES.has(new URL(provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function ensureRootObjectType(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  const obj = parameters as Record<string, unknown>;
  if (obj.type === "object") return obj;
  return { ...obj, type: "object" };
}

export function isXaiObjectSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function moonshotRefTargetKeys(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter(key => key !== "$ref");
}

export const MOONSHOT_MAX_REF_EXPANSIONS = 512;

export const MOONSHOT_MAX_SCHEMA_DEPTH = 64;

export const MOONSHOT_MAX_SCHEMA_NODES = 4_096;

export function unionRequired(target: unknown, sibling: unknown): unknown {
  if (!Array.isArray(target) || !Array.isArray(sibling)) return sibling;
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const name of [...target, ...sibling]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export const MOONSHOT_DATA_VALUED_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

export const MOONSHOT_BOUND_KEYWORDS: Record<string, "max" | "min"> = {
  minLength: "max",
  minItems: "max",
  minProperties: "max",
  minimum: "max",
  exclusiveMinimum: "max",
  maxLength: "min",
  maxItems: "min",
  maxProperties: "min",
  maximum: "min",
  exclusiveMaximum: "min",
};

export function intersectBound(target: unknown, sibling: unknown, direction: "max" | "min"): unknown {
  const a = typeof target === "number" && Number.isFinite(target) ? target : null;
  const b = typeof sibling === "number" && Number.isFinite(sibling) ? sibling : null;
  if (a === null) return b === null ? sibling : sibling;
  if (b === null) return target;
  return direction === "max" ? Math.max(a, b) : Math.min(a, b);
}

export function composeProperties(
  target: Record<string, unknown>,
  sibling: Record<string, unknown>,
): Record<string, unknown> {
  const combined: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, sub] of Object.entries(target)) combined[name] = sub;
  for (const [name, sub] of Object.entries(sibling)) {
    const existing = combined[name];
    if (isXaiObjectSchema(existing) && isXaiObjectSchema(sub)) {
      const member: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(existing)) member[k] = v;
      for (const [k, v] of Object.entries(sub)) {
        if (k === "required") {
          member[k] = unionRequired(member[k], v);
          continue;
        }
        if (k === "properties" && isXaiObjectSchema(member[k]) && isXaiObjectSchema(v)) {
          member[k] = composeProperties(member[k] as Record<string, unknown>, v);
          continue;
        }
        const boundDirection = MOONSHOT_BOUND_KEYWORDS[k];
        if (boundDirection && k in member) {
          member[k] = intersectBound(member[k], v, boundDirection);
          continue;
        }
        member[k] = v;
      }
      combined[name] = member;
      continue;
    }
    combined[name] = sub;
  }
  return combined;
}

export interface MoonshotNormalizeState {
  activeRefs: Set<string>;
  remainingExpansions: number;
  remainingNodes: number;
}

export function normalizeMoonshotSchemaNode(
  node: unknown,
  root: Record<string, unknown>,
  state: MoonshotNormalizeState,
  depth = 0,
): unknown {
  if (Array.isArray(node)) {
    if (depth >= MOONSHOT_MAX_SCHEMA_DEPTH) return [];
    return node.map(item => normalizeMoonshotSchemaNode(item, root, state, depth + 1));
  }
  if (!isXaiObjectSchema(node)) return node;

  // Fail closed for this node rather than emitting a partially weakened schema: an empty
  // object is the one shape that asserts nothing it cannot back up.
  if (depth >= MOONSHOT_MAX_SCHEMA_DEPTH || state.remainingNodes <= 0) return {};
  state.remainingNodes -= 1;

  const ref = node.$ref;
  const hasSiblings = moonshotRefTargetKeys(node).length > 0;

  if (typeof ref === "string" && hasSiblings) {
    // A cycle cannot be inlined. Keeping the bare `$ref` is the lossy-but-valid fallback:
    // Moonshot accepts it, and the alternative (dropping the ref) would erase the recursion.
    if (state.activeRefs.has(ref) || state.remainingExpansions <= 0) return { $ref: ref };

    const target = lookupLocalJsonPointer(root, ref);
    if (isXaiObjectSchema(target)) {
      state.remainingExpansions -= 1;
      state.activeRefs.add(ref);
      const resolvedTarget = normalizeMoonshotSchemaNode(target, root, state, depth + 1);
      state.activeRefs.delete(ref);
      const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (isXaiObjectSchema(resolvedTarget)) {
        for (const [key, value] of Object.entries(resolvedTarget)) merged[key] = value;
      }
      // "Alongside the target" is conjunction, not replacement. For most keywords the node
      // narrows the target and overwriting is the narrower reading, but `required` and
      // `properties` are set-valued: letting the sibling win DROPPED the target's own
      // members, so a tool requiring `a` beside a node requiring `b` shipped requiring only
      // `b`. Those two compose; everything else keeps the narrowing overwrite.
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref") continue;
        if (MOONSHOT_DATA_VALUED_KEYWORDS.has(key)) {
          merged[key] = value;
          continue;
        }
        const normalized = normalizeMoonshotSchemaNode(value, root, state, depth + 1);
        if (key === "required") {
          merged[key] = unionRequired(merged[key], normalized);
          continue;
        }
        if (key === "properties" && isXaiObjectSchema(merged[key]) && isXaiObjectSchema(normalized)) {
          merged[key] = composeProperties(merged[key] as Record<string, unknown>, normalized);
          continue;
        }
        // Numeric bounds intersect rather than overwrite: both the node and its target
        // apply, so the surviving bound is the stricter of the two in whichever direction
        // that keyword tightens.
        const boundDirection = MOONSHOT_BOUND_KEYWORDS[key];
        if (boundDirection && key in merged) {
          merged[key] = intersectBound(merged[key], normalized, boundDirection);
          continue;
        }
        merged[key] = normalized;
      }
      return merged;
    }

    // Unresolvable pointer: a remote ref, a malformed path, or a non-object target. Dropping
    // the ref and keeping the siblings silently discards whatever the reference constrained,
    // which is the one outcome we cannot detect downstream. A bare `$ref` is lossy in the
    // other direction - it loses the node's own keywords - but it preserves the identity of
    // what was asked for, and Moonshot accepts it.
    return { $ref: ref };
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === "$ref" || MOONSHOT_DATA_VALUED_KEYWORDS.has(key)
      ? value
      : normalizeMoonshotSchemaNode(value, root, state, depth + 1);
  }
  return out;
}

export function normalizeMoonshotToolParameters(parameters: unknown): Record<string, unknown> {
  const rooted = ensureRootObjectType(parameters);
  const normalized = normalizeMoonshotSchemaNode(rooted, rooted, {
    activeRefs: new Set<string>(),
    remainingExpansions: MOONSHOT_MAX_REF_EXPANSIONS,
    remainingNodes: MOONSHOT_MAX_SCHEMA_NODES,
  });
  return isXaiObjectSchema(normalized) ? normalized : rooted;
}

export function thinkingBudgetForEffort(parsed: OcxParsedRequest, reasoningEffort: string, maxOutputTokens?: number): number | undefined {
  if (parsed.options.reasoning === "minimal") return 0;
  const maxBudget = maxOutputTokens ?? 32768;
  const fractions: Record<string, number> = {
    low: 0.20,
    medium: 0.50,
    high: 0.75,
    xhigh: 0.90,
    max: 1.0,
  };
  const fraction = fractions[reasoningEffort];
  return fraction === undefined ? undefined : Math.max(1, Math.floor(maxBudget * fraction));
}
