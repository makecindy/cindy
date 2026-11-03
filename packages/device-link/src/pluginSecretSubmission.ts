/** Dedicated trusted Desktop input only; never add this channel to the remote allowlist. */
export const PLUGIN_SECRET_LOCAL_CHANNEL = "plugin-oauth:submit-secret";
export const PLUGIN_SECRET_MAX_CHARS = 4096;
/** What the user saw before typing. Main compares it with the authenticated Host offer. */
export interface PluginSecretPresentation {
  ghostName: string;
  title: string;
  description: string;
  intro: string;
  fieldLabel: string;
  fieldDescription: string;
  maxLength: number;
}
export interface PluginSecretOffer {
  kind: "secret-entry";
  state: string;
  presentation: PluginSecretPresentation;
}
export interface PluginSecretValue {
  kind: "secret-value";
  state: string;
  value: string;
}
const fail = () => new Error("PLUGIN_SECRET_UNAVAILABLE");
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
  return raw as Record<string, unknown>;
}
export function parsePluginSecretOffer(raw: unknown): PluginSecretOffer {
  const v = object(raw);
  if (
    Object.keys(v).sort().join(",") !== "kind,presentation,state" ||
    v.kind !== "secret-entry" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  return {
    kind: v.kind,
    state: v.state,
    presentation: parsePluginSecretPresentation(v.presentation),
  };
}
export function parsePluginSecretPresentation(
  raw: unknown,
): PluginSecretPresentation {
  const v = object(raw);
  const keys = [
    "ghostName",
    "title",
    "description",
    "intro",
    "fieldLabel",
    "fieldDescription",
  ];
  if (
    Object.keys(v).length !== keys.length + 1 ||
    keys.some((k) => !Object.hasOwn(v, k)) ||
    keys.some(
      (k) => typeof v[k] !== "string" || (v[k] as string).length > 4096,
    ) ||
    !v.ghostName ||
    !v.fieldLabel ||
    !Number.isSafeInteger(v.maxLength) ||
    (v.maxLength as number) < 1 ||
    (v.maxLength as number) > PLUGIN_SECRET_MAX_CHARS
  )
    throw fail();
  return {
    ghostName: v.ghostName as string,
    title: v.title as string,
    description: v.description as string,
    intro: v.intro as string,
    fieldLabel: v.fieldLabel as string,
    fieldDescription: v.fieldDescription as string,
    maxLength: v.maxLength as number,
  };
}
export function parsePluginSecretValue(raw: unknown): PluginSecretValue {
  const v = object(raw);
  if (
    Object.keys(v).sort().join(",") !== "kind,state,value" ||
    v.kind !== "secret-value" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  return {
    kind: v.kind,
    state: v.state,
    value: parsePluginSecretInput(v.value),
  };
}

/** Validate local input before a transaction exists, without inventing a bridge state. */
export function parsePluginSecretInput(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > PLUGIN_SECRET_MAX_CHARS ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw fail();
  return value;
}
