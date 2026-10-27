export const PLUGIN_SETTINGS_ACTION = "settings-page";
const oauthId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export type PluginSettingsCommand =
  | { kind: "document"; epoch: number }
  | { kind: "fetch"; path: string; method: string; body?: string }
  | { kind: "asset"; path: string; offset: number }
  | { kind: "subscribe"; channels: string[] }
  | { kind: "unsubscribe"; channel: string }
  | { kind: "post"; channel: string; data: unknown }
  | { kind: "poll"; after: number }
  | { kind: "confirm"; requestId: string; accepted: boolean }
  | { kind: "answer-directory"; requestId: string; path: string | null }
  | { kind: "authorize"; path: string; body?: string }
  | { kind: "authorization-result"; requestId: string }
  | { kind: "close" };

/** Only accepted inside a signed, encrypted v3 exchange bound to a settings-page lease. */
export interface PluginSettingsRequest {
  op: "settings";
  id: string;
  command: PluginSettingsCommand;
}

export function parsePluginSettingsRequest(
  raw: unknown,
): PluginSettingsRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).length !== 3 ||
    v.op !== "settings" ||
    !oauthId(v.id) ||
    !v.command ||
    typeof v.command !== "object" ||
    Array.isArray(v.command)
  )
    return null;
  const c = v.command as Record<string, unknown>;
  const exact = (keys: string[]) =>
    Object.keys(c).length === keys.length &&
    keys.every((k) => Object.hasOwn(c, k));
  const path = (p: unknown): p is string =>
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 2048 &&
    !/[\x00-\x1f]/.test(p);
  const body =
    c.body === undefined ||
    (typeof c.body === "string" &&
      new TextEncoder().encode(c.body).length <= 65_536);
  const channel = (name: unknown): name is string =>
    typeof name === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name);
  let valid = false;
  switch (c.kind) {
    case "document":
      valid = exact(["kind", "epoch"]) && Number.isSafeInteger(c.epoch) && (c.epoch as number) > 0;
      break;
    case "fetch":
      valid =
        exact([
          "kind",
          "path",
          "method",
          ...(c.body === undefined ? [] : ["body"]),
        ]) &&
        path(c.path) &&
        ["GET", "PUT", "POST", "DELETE"].includes(c.method as string) &&
        body;
      break;
    case "asset":
      valid =
        exact(["kind", "path", "offset"]) &&
        path(c.path) &&
        Number.isSafeInteger(c.offset) &&
        (c.offset as number) >= 0;
      break;
    case "subscribe":
      valid =
        exact(["kind", "channels"]) &&
        Array.isArray(c.channels) &&
        c.channels.length <= 16 &&
        c.channels.every(channel);
      break;
    case "post":
      try {
        valid =
          exact(["kind", "channel", "data"]) &&
          channel(c.channel) &&
          new TextEncoder().encode(JSON.stringify(c.data)).length <= 49_152;
      } catch {
        return null;
      }
      break;
    case "unsubscribe":
      valid = exact(["kind", "channel"]) && channel(c.channel);
      break;
    case "poll":
      valid =
        exact(["kind", "after"]) &&
        Number.isSafeInteger(c.after) &&
        (c.after as number) >= 0;
      break;
    case "confirm":
      valid =
        exact(["kind", "requestId", "accepted"]) &&
        oauthId(c.requestId) &&
        typeof c.accepted === "boolean";
      break;
    case "answer-directory":
      valid =
        exact(["kind", "requestId", "path"]) &&
        oauthId(c.requestId) &&
        (c.path === null ||
          (typeof c.path === "string" &&
            c.path.length > 0 &&
            c.path.length <= 4096 &&
            !/[\x00-\x1f]/.test(c.path)));
      break;
    case "authorize":
      valid =
        exact(["kind", "path", ...(c.body === undefined ? [] : ["body"])]) &&
        path(c.path) &&
        body;
      break;
    case "authorization-result":
      valid = exact(["kind", "requestId"]) && oauthId(c.requestId);
      break;
    case "close":
      valid = exact(["kind"]);
      break;
  }
  return valid ? (v as unknown as PluginSettingsRequest) : null;
}
