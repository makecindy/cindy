import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";
import { namespacedToolName } from "../types/tools";
import { rewriteRoutedNamespaceToolsForUpstream } from "./namespace-tool-compat";
import { collectResponsesToolGroups } from "./tool-groups";

export interface FunctionCallRepairSchema {
  name: string;
  namespace?: string;
  parameters?: Record<string, unknown>;
}

/** Keys are canonical original identities, never a bare-name fallback for a namespace. */
export type FunctionCallRepairSchemas = ReadonlyMap<string, FunctionCallRepairSchema>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON object member order is immaterial; array elements retain their exact order. */
function sameSchemaValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameSchemaValue(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameSchemaValue(left[key], right[key]));
}

function namespaceOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "functions" ? value : undefined;
}

function selectorAllows(
  selector: unknown,
  lowered: unknown,
  wireName: string,
  identity: FunctionCallRepairSchema,
): boolean {
  if (!isObject(selector) || selector.type !== "function" || typeof selector.name !== "string") return false;
  if ("namespace" in selector) {
    if (typeof selector.namespace !== "string" || selector.namespace.length === 0) return false;
    return namespaceOf(selector.namespace) === identity.namespace && selector.name === identity.name;
  }
  return isObject(lowered) && lowered.type === "function" && lowered.name === wireName;
}

/** Caller supplies currentTurnWireToolCatalogBody BEFORE provider schema lowering. */
export interface FunctionCallRepairPlan {
  /** Wire names the live request allocated for displaced namespace children. */
  renamedWireNames: ReadonlyMap<string, string>;
  /** `tool_choice` after the request's own lowering, so selectors match the forwarded body. */
  loweredToolChoice?: unknown;
}

export function collectFunctionCallRepairSchemas(
  body: unknown,
  plan?: FunctionCallRepairPlan,
): Map<string, FunctionCallRepairSchema> {
  const schemas = new Map<string, FunctionCallRepairSchema>();
  if (!isObject(body)) return schemas;
  const liveGroups: unknown[][] = [];
  if (Array.isArray(body.tools)) liveGroups.push(body.tools);
  const replayedGroups: unknown[][] = [];
  if (Array.isArray(body.input)) {
    for (const entry of body.input) {
      if (!isObject(entry) || !Array.isArray(entry.tools)) continue;
      if (entry.type === "tool_search_output") replayedGroups.push(entry.tools);
      else if (entry.type === "additional_tools") liveGroups.push(entry.tools);
    }
  }
  // The forwarded request owns both the wire names and the lowered selector. Rebuilding them from
  // a combined catalog would let replayed history change either, which the request itself never
  // did; only a caller without a plan falls back to the local view.
  let loweredChoice: unknown;
  let renamedWireNames: ReadonlyMap<string, string>;
  if (plan) {
    loweredChoice = plan.loweredToolChoice;
    renamedWireNames = plan.renamedWireNames;
  } else {
    const derived = rewriteRoutedNamespaceToolsForUpstream({ ...body, tools: [...liveGroups, ...replayedGroups].flat(), input: [] });
    loweredChoice = isObject(derived.body) ? derived.body.tool_choice : undefined;
    renamedWireNames = derived.renamedWireNames;
  }
  const choice = body.tool_choice;
  const occupied = new Map<string, { kind: unknown; identity: FunctionCallRepairSchema; live: boolean } | null>();
  const register = (tool: unknown, namespace: string | undefined, live: boolean): void => {
    if (!isObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) return;
    const identity: FunctionCallRepairSchema = {
      name: tool.name,
      ...(namespace ? { namespace } : {}),
      ...(isObject(tool.parameters) ? { parameters: tool.parameters } : {}),
    };
    const preferred = namespacedToolName(namespace, tool.name);
    // Only a namespace child can be displaced; a bare declaration keeps its own name even when it
    // happens to spell the same preferred wire name.
    const key = namespace ? (renamedWireNames.get(preferred) ?? preferred) : preferred;
    if (occupied.has(key)) {
      const previous = occupied.get(key);
      if (!previous) return;
      const sameIdentity = previous.identity.namespace === namespace
        && previous.identity.name === tool.name;
      if (sameIdentity) {
        // One tool declared twice: identical declarations collapse, contradictory ones cannot be
        // ordered by which catalog happened to carry them.
        const same = previous.kind === tool.type
          && sameSchemaValue(previous.identity.parameters, identity.parameters);
        if (!same) occupied.set(key, null);
        return;
      }
      // Two different tools want one wire name. The live catalog owns it; replayed history —
      // which never took part in the allocation — steps aside. Two tools from the same source
      // cannot be ordered, so that stays ambiguous.
      if (previous.live !== live) {
        if (live) occupied.set(key, { kind: tool.type, identity, live });
        return;
      }
      occupied.set(key, null);
      return;
    }
    occupied.set(key, { kind: tool.type, identity, live });
  };
  const groups: [unknown[], boolean][] = [
    ...liveGroups.map(group => [group, true] as [unknown[], boolean]),
    ...replayedGroups.map(group => [group, false] as [unknown[], boolean]),
  ];
  for (const [group, live] of groups) {
    for (const tool of group) {
      if (!isObject(tool)) continue;
      if (tool.type === "namespace") {
        if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) continue;
        for (const child of tool.tools) register(child, namespaceOf(tool.name), live);
      } else if (tool.type === "function" && isObject(tool.function)) {
        register({ ...tool.function, type: "function" }, undefined, live);
      } else register(tool, undefined, live);
    }
  }
  for (const [key, entry] of occupied) {
    if (!entry || entry.kind !== "function") continue;
    let allowed = choice === undefined || choice === "auto" || choice === "required";
    if (isObject(choice)) {
      if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
        const selectors = isObject(loweredChoice) && Array.isArray(loweredChoice.tools) ? loweredChoice.tools : [];
        allowed = choice.tools.some((selector, index) => selectorAllows(selector, selectors[index], key, entry.identity));
      } else allowed = selectorAllows(choice, loweredChoice, key, entry.identity);
    }
    if (allowed) schemas.set(key, entry.identity);
  }
  return schemas;
}

function repairItem(
  item: unknown,
  schemas: FunctionCallRepairSchemas,
  completed: boolean,
  renamedWireNames?: ReadonlyMap<string, string>,
): unknown {
  if (!isObject(item) || item.type !== "function_call" || typeof item.name !== "string"
    || typeof item.arguments !== "string") return item;
  if (item.status !== "completed" && !(item.status === undefined && completed)) return item;
  if ("namespace" in item && (typeof item.namespace !== "string" || !item.namespace)) return item;
  const namespace = namespaceOf(item.namespace);
  const preferred = namespacedToolName(namespace, item.name);
  // A restored namespace coordinate names the declaration, not the allocated wire name; only an
  // item that actually carries the namespace is mapped, so the bare declaration keeps its own key.
  const key = "namespace" in item ? (renamedWireNames?.get(preferred) ?? preferred) : preferred;
  const schema = schemas.get(key);
  if (!schema) return item;
  // An explicit namespace is an identity coordinate, not another spelling to guess at.
  if ("namespace" in item && (schema.namespace !== namespace || schema.name !== item.name)) return item;
  const raw = item.arguments;
  if (raw !== "") {
    try {
      let unsafe = false;
      JSON.parse(raw, (_key, value: unknown) => {
        if (typeof value === "number" && (!Number.isFinite(value)
          || (Number.isInteger(value) && !Number.isSafeInteger(value)))) unsafe = true;
        return value;
      });
      // Re-stringifying another repaired field must not round an unsafe sibling number.
      if (unsafe) return item;
    } catch { return item; }
  }
  const argumentsText = coerceIntegerToolArguments(raw || "{}", schema.parameters, schema.namespace ? undefined : schema.name);
  return argumentsText === raw ? item : { ...item, arguments: argumentsText };
}

/** Only executable completion slots are visited; metadata and custom input are opaque. */
export function repairFunctionCalls(
  value: unknown,
  schemas: FunctionCallRepairSchemas,
  renamedWireNames?: ReadonlyMap<string, string>,
): { value: unknown; changed: boolean } {
  if (schemas.size === 0 || !isObject(value)) return { value, changed: false };
  if (typeof value.status === "string" && ["failed", "incomplete", "cancelled", "in_progress", "queued"].includes(value.status)) return { value, changed: false };
  let next: unknown = value;
  if (value.type === "function_call") next = repairItem(value, schemas, false, renamedWireNames);
  else if (value.type === "response.output_item.done") {
    const item = repairItem(value.item, schemas, true, renamedWireNames);
    if (item !== value.item) next = { ...value, item };
  } else if (value.type === "response.completed" && isObject(value.response)) {
    const response = value.response;
    if ((response.status === undefined || response.status === "completed") && Array.isArray(response.output)) {
      const original = response.output;
      const output = original.map(item => repairItem(item, schemas, true, renamedWireNames));
      if (output.some((item, index) => item !== original[index])) next = { ...value, response: { ...response, output } };
    }
  } else if (typeof value.type !== "string" || !value.type.startsWith("response.")) {
    if (Array.isArray(value.output)) {
      const original = value.output;
      const output = original.map(item => repairItem(item, schemas, value.status === "completed", renamedWireNames));
      if (output.some((item, index) => item !== original[index])) next = { ...value, output };
    }
  }
  return { value: next, changed: next !== value };
}

export function repairFunctionCallsInJson(
  text: string,
  schemas: FunctionCallRepairSchemas,
  renamedWireNames?: ReadonlyMap<string, string>,
): string {
  if (schemas.size === 0) return text;
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return text; }
  const repaired = repairFunctionCalls(payload, schemas, renamedWireNames);
  return repaired.changed ? JSON.stringify(repaired.value) : text;
}
