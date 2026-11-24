import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";
import { dottedToolName, namespacedToolName } from "../types/tools";
import { rewriteRoutedNamespaceToolsForUpstream } from "./namespace-tool-compat";

export interface FunctionCallRepairSchema {
  name: string;
  namespace?: string;
  parameters?: Record<string, unknown>;
}

export interface FunctionCallRepairSchemas {
  byIdentity: ReadonlyMap<string, FunctionCallRepairSchema>;
  byWireName: ReadonlyMap<string, FunctionCallRepairSchema>;
  namespacedFunctions: ReadonlySet<string>;
}

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

function identityKey(namespace: string | undefined, name: string): string {
  return JSON.stringify([namespace, name]);
}

export function hasDeclaredNamespacedFunction(
  schemas: FunctionCallRepairSchemas,
  namespace: string,
  name: string,
): boolean {
  return schemas.namespacedFunctions.has(identityKey(namespace, name));
}

function selectorAllows(
  selector: unknown,
  lowered: unknown,
  wireName: string | undefined,
  identity: FunctionCallRepairSchema,
  key: string,
  historySelectors?: ReadonlyMap<string, string | null>,
): boolean {
  if (!isObject(selector) || selector.type !== "function" || typeof selector.name !== "string") return false;
  if ("namespace" in selector) {
    if (typeof selector.namespace !== "string" || selector.namespace.length === 0) return false;
    return namespaceOf(selector.namespace) === identity.namespace && selector.name === identity.name;
  }
  if (!isObject(lowered) || lowered.type !== "function" || typeof lowered.name !== "string") return false;
  if (lowered.name === selector.name && historySelectors?.has(selector.name)) {
    return historySelectors.get(selector.name) === key;
  }
  return lowered.name === wireName;
}

/** Caller supplies currentTurnWireToolCatalogBody BEFORE provider schema lowering. */
export interface FunctionCallRepairPlan {
  /** Wire names the live request allocated for displaced namespace children. */
  renamedWireNames: ReadonlyMap<string, string>;
  /** `tool_choice` after the request's own lowering, so selectors match the forwarded body. */
  loweredToolChoice?: unknown;
}

/** Native repair has no lowered live request; retain loaded tool-search schemas and selectors. */
export function deriveFunctionCallRepairPlan(body: unknown): FunctionCallRepairPlan & {
  renamedKinds: Map<string, "function" | "custom">;
} {
  if (!isObject(body)) return { renamedWireNames: new Map(), renamedKinds: new Map() };
  const groups: unknown[][] = Array.isArray(body.tools) ? [body.tools] : [];
  if (Array.isArray(body.input)) {
    for (const entry of body.input) {
      if (isObject(entry) && (entry.type === "additional_tools" || entry.type === "tool_search_output")
        && Array.isArray(entry.tools)) groups.push(entry.tools);
    }
  }
  const derived = rewriteRoutedNamespaceToolsForUpstream({ ...body, tools: groups.flat(), input: [] });
  return {
    renamedWireNames: derived.renamedWireNames,
    renamedKinds: derived.renamedKinds,
    loweredToolChoice: isObject(derived.body) ? derived.body.tool_choice : undefined,
  };
}

export function collectFunctionCallRepairSchemas(
  body: unknown,
  plan?: FunctionCallRepairPlan,
  currentInlineIndex?: number,
): FunctionCallRepairSchemas {
  const byIdentity = new Map<string, FunctionCallRepairSchema>();
  const byWireName = new Map<string, FunctionCallRepairSchema>();
  const namespacedFunctions = new Set<string>();
  const schemas = { byIdentity, byWireName, namespacedFunctions };
  if (!isObject(body)) return schemas;
  const liveGroups: unknown[][] = [];
  if (Array.isArray(body.tools)) liveGroups.push(body.tools);
  const searchGroups: unknown[][] = [];
  const historicalGroups: unknown[][] = [];
  if (Array.isArray(body.input)) {
    for (const [index, entry] of body.input.entries()) {
      if (!isObject(entry) || !Array.isArray(entry.tools)) continue;
      if (entry.type === "tool_search_output" || entry.type === "tool_search_call_output") {
        (index < (currentInlineIndex ?? -1) ? historicalGroups : searchGroups).push(entry.tools);
      } else if (entry.type === "additional_tools") {
        (currentInlineIndex === undefined || index === currentInlineIndex ? liveGroups : historicalGroups).push(entry.tools);
      }
    }
  }
  // Namespace lowering keeps live top-level declarations over reserved-group duplicates.
  // Use that same canonical catalog for schemas, without masking two top-level conflicts.
  const canonicalBareNames = new Set<string>();
  for (const group of liveGroups) {
    for (const tool of group) {
      if (isObject(tool) && tool.type !== "namespace" && typeof tool.name === "string") canonicalBareNames.add(tool.name);
    }
  }
  // The forwarded request owns all wire names. Search history can only resolve selectors that
  // had no match when the request was lowered; it must never allocate its own wire names here.
  const { loweredToolChoice: loweredChoice, renamedWireNames } = plan ?? deriveFunctionCallRepairPlan(body);
  const choice = body.tool_choice;
  const selectorOwners = (searchGroups.length > 0 || historicalGroups.length > 0) && isObject(choice)
    ? new Map<string, { key: string | null; historical: boolean }>()
    : undefined;
  const declarations = new Map<string, { kind: unknown; identity: FunctionCallRepairSchema; live: boolean; historical: boolean; wireName: string } | null>();
  const wireOwners = new Map<string, { key: string | null; live: boolean; historical: boolean }>();
  const liveNamespacedIdentities = new Set<string>();
  const currentSearchIdentities = new Set<string>();
  const register = (tool: unknown, declaredNamespace: string | undefined, live: boolean, historical: boolean): void => {
    if (!isObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) return;
    const namespace = namespaceOf(declaredNamespace);
    const identity: FunctionCallRepairSchema = {
      name: tool.name,
      ...(namespace ? { namespace } : {}),
      ...(isObject(tool.parameters) ? { parameters: tool.parameters } : {}),
    };
    const preferred = namespacedToolName(namespace, tool.name);
    const wireName = namespace ? (renamedWireNames.get(preferred) ?? preferred) : preferred;
    const key = identityKey(namespace, tool.name);
    // Type restoration uses the live declaration when present, independently of schema conflicts.
    if (namespace) {
      if (live) liveNamespacedIdentities.add(key);
      if (!live && !historical) currentSearchIdentities.add(key);
      if (tool.type === "function" && (live || (!liveNamespacedIdentities.has(key)
        && (!historical || !currentSearchIdentities.has(key))))) namespacedFunctions.add(key);
    }
    // Register the live catalog first. History can supply an explicit coordinate even if another
    // tool already owns its wire name. Two different tools with equal priority make the wire name ambiguous.
    const owner = wireOwners.get(wireName);
    if (owner === undefined) wireOwners.set(wireName, { key, live, historical });
    else if (owner.key !== key && owner.live === live && owner.historical === historical) owner.key = null;
    if (selectorOwners) {
      const names = declaredNamespace ? [tool.name, dottedToolName(declaredNamespace, tool.name)] : [tool.name];
      for (const name of names) {
        const previous = selectorOwners.get(name);
        if (!previous) selectorOwners.set(name, { key, historical });
        else if (previous.historical === historical && previous.key !== key) previous.key = null;
      }
    }
    const previous = declarations.get(key);
    if (previous === undefined) declarations.set(key, { kind: tool.type, identity, live, historical, wireName });
    // This turn's declarations and loaded search outputs take priority over replayed schemas.
    // Conflicting declarations in the selected catalog still withhold repair.
    else if (previous && (!historical || previous.historical)
      && (previous.kind !== tool.type || !sameSchemaValue(previous.identity.parameters, identity.parameters))) {
      declarations.set(key, null);
    }
  };
  const groups = [
    ...liveGroups.map(group => ({ group, live: true, historical: false })),
    ...searchGroups.map(group => ({ group, live: false, historical: false })),
    ...historicalGroups.map(group => ({ group, live: false, historical: true })),
  ];
  for (const { group, live, historical } of groups) {
    for (const tool of group) {
      if (!isObject(tool)) continue;
      if (tool.type === "namespace") {
        if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) continue;
        for (const child of tool.tools) {
          if (tool.name === "functions" && isObject(child) && typeof child.name === "string"
            && canonicalBareNames.has(child.name)) continue;
          register(child, tool.name, live, historical);
        }
      } else if (tool.type === "function" && isObject(tool.function)) {
        register({ ...tool.function, type: "function" }, undefined, live, historical);
      } else register(tool, undefined, live, historical);
    }
  }
  // An unchanged selector can already be a wire name. An exact owner in the same or a
  // newer catalog takes precedence even when that owner has no repairable schema.
  const historySelectors = selectorOwners && new Map([...selectorOwners]
    .filter(([name, entry]) => {
      const owner = wireOwners.get(name);
      return !owner || (owner.historical && !entry.historical);
    })
    .map(([name, entry]) => [name, entry.key]));
  for (const [key, entry] of declarations) {
    if (!entry || entry.kind !== "function") continue;
    const wireName = wireOwners.get(entry.wireName)?.key === key ? entry.wireName : undefined;
    let allowed = choice === undefined || choice === "auto" || choice === "required";
    if (isObject(choice)) {
      const fallback = entry.live ? undefined : historySelectors;
      if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
        const selectors = isObject(loweredChoice) && Array.isArray(loweredChoice.tools) ? loweredChoice.tools : [];
        allowed = choice.tools.some((selector, index) => selectorAllows(selector, selectors[index], wireName, entry.identity, key, fallback));
      } else allowed = selectorAllows(choice, loweredChoice, wireName, entry.identity, key, fallback);
    }
    if (allowed) {
      byIdentity.set(key, entry.identity);
      if (wireName !== undefined) byWireName.set(wireName, entry.identity);
    }
  }
  return schemas;
}

function repairItem(
  item: unknown,
  schemas: FunctionCallRepairSchemas,
  completed: boolean,
): unknown {
  if (!isObject(item) || item.type !== "function_call" || typeof item.name !== "string"
    || typeof item.arguments !== "string") return item;
  if (item.status !== "completed" && !(item.status === undefined && completed)) return item;
  if ("namespace" in item && (typeof item.namespace !== "string" || !item.namespace)) return item;
  const schema = "namespace" in item
    ? schemas.byIdentity.get(identityKey(namespaceOf(item.namespace), item.name))
    : schemas.byWireName.get(item.name);
  if (!schema) return item;
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
): { value: unknown; changed: boolean } {
  if (schemas.byIdentity.size === 0 || !isObject(value)) return { value, changed: false };
  if (typeof value.status === "string" && ["failed", "incomplete", "cancelled", "in_progress", "queued"].includes(value.status)) return { value, changed: false };
  let next: unknown = value;
  if (value.type === "function_call") next = repairItem(value, schemas, false);
  else if (value.type === "response.output_item.done") {
    const item = repairItem(value.item, schemas, true);
    if (item !== value.item) next = { ...value, item };
  } else if (value.type === "response.completed" && isObject(value.response)) {
    const response = value.response;
    if ((response.status === undefined || response.status === "completed") && Array.isArray(response.output)) {
      const original = response.output;
      const output = original.map(item => repairItem(item, schemas, true));
      if (output.some((item, index) => item !== original[index])) next = { ...value, response: { ...response, output } };
    }
  } else if (typeof value.type !== "string" || !value.type.startsWith("response.")) {
    if (Array.isArray(value.output)) {
      const original = value.output;
      const output = original.map(item => repairItem(item, schemas, value.status === "completed"));
      if (output.some((item, index) => item !== original[index])) next = { ...value, output };
    }
  }
  return { value: next, changed: next !== value };
}

export function repairFunctionCallsInJson(
  text: string,
  schemas: FunctionCallRepairSchemas,
): string {
  if (schemas.byIdentity.size === 0) return text;
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return text; }
  const repaired = repairFunctionCalls(payload, schemas);
  return repaired.changed ? JSON.stringify(repaired.value) : text;
}
