/** Local trusted form only. Never expose this IPC through the remote allowlist. */
export const PLUGIN_CONNECTION_LOCAL_CHANNEL = "plugin-oauth:submit-connection";
export interface PluginConnectionInput {
  host: string;
  token: string;
}
export interface PluginConnectionPresentation {
  ghostName: string;
  title: string;
  description: string;
  intro: string;
  connectionKey: string;
}
export interface PluginConnectionOffer {
  kind: "connection-entry";
  state: string;
  presentation: PluginConnectionPresentation;
}
export interface PluginConnectionValue {
  kind: "connection-value";
  state: string;
  value: PluginConnectionInput;
}
const fail = () => new Error("PLUGIN_CONNECTION_UNAVAILABLE");
function exact(raw: unknown, keys: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== keys.split(" ").sort().join(",")
  )
    throw fail();
  return raw as Record<string, unknown>;
}
/** HTTPS default port and a single exact DNS host. Never a wildcard, path or IP. */
export function normalizePluginConnectionHost(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512) throw fail();
  const text = raw.trim();
  if (!text || /[\s\\]/u.test(text)) throw fail();
  let host = text.toLowerCase();
  if (text.includes("://")) {
    // Validate before URL normalizes dot-segments or escaped host characters.
    if (!/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/iu.test(text)) throw fail();
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw fail();
    }
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw fail();
    host = url.hostname;
  }
  if (
    host.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      host,
    ) ||
    /^[0-9.]+$/u.test(host)
  )
    throw fail();
  return host;
}
export function parsePluginConnectionInput(
  raw: unknown,
): PluginConnectionInput {
  const value = exact(raw, "host token");
  if (typeof value.token !== "string") throw fail();
  const token = value.token.trim();
  if (!token || token.length > 4096 || /[\x00-\x20\x7f]/u.test(token))
    throw fail();
  return { host: normalizePluginConnectionHost(value.host), token };
}
export function parsePluginConnectionPresentation(
  raw: unknown,
): PluginConnectionPresentation {
  const value = exact(raw, "ghostName title description intro connectionKey");
  if (
    Object.values(value).some(
      (v) => typeof v !== "string" || v.length > 4096,
    ) ||
    !value.ghostName ||
    typeof value.connectionKey !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.connectionKey)
  )
    throw fail();
  return {
    ghostName: value.ghostName as string,
    title: value.title as string,
    description: value.description as string,
    intro: value.intro as string,
    connectionKey: value.connectionKey,
  };
}
function state(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(raw))
    throw fail();
  return raw;
}
export function parsePluginConnectionOffer(
  raw: unknown,
): PluginConnectionOffer {
  const value = exact(raw, "kind state presentation");
  if (value.kind !== "connection-entry") throw fail();
  return {
    kind: value.kind,
    state: state(value.state),
    presentation: parsePluginConnectionPresentation(value.presentation),
  };
}
export function parsePluginConnectionValue(
  raw: unknown,
): PluginConnectionValue {
  const value = exact(raw, "kind state value");
  if (value.kind !== "connection-value") throw fail();
  return {
    kind: value.kind,
    state: state(value.state),
    value: parsePluginConnectionInput(value.value),
  };
}
