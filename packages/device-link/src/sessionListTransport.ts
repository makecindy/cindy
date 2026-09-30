import type { InvokePayload } from "./protocol.js";

const channel = "local-db:sessions:list";
const format = "session-tag-catalog-v1";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Per-request opt-in also works before link establishment. Old hosts ignore it. */
export function requestSessionTagCatalog(
  payload: InvokePayload,
): InvokePayload {
  if (payload.channel !== channel) return payload;
  const args = [...(payload.args ?? [])];
  if (args[2] != null && !record(args[2])) return payload;
  args[2] = {
    ...(args[2] as Record<string, unknown> | undefined),
    tagCatalog: 1,
  };
  return { ...payload, args };
}

/** Pack only the authorized result; never send unused directory entries. */
export function encodeSessionTagCatalog(
  name: string | undefined,
  args: unknown[] | undefined,
  value: unknown,
): unknown {
  if (
    name !== channel ||
    !record(args?.[2]) ||
    args[2].tagCatalog !== 1 ||
    !Array.isArray(value)
  )
    return value;
  const tags: unknown[] = [];
  const byValue = new Map<string, number>();
  const sessions = value.map((row) => {
    if (!record(row) || !Array.isArray(row.tags)) return row;
    // Index references preserve even differing snapshots of the same ID exactly.
    const tagIds = row.tags.map((tag) => {
      const key = JSON.stringify(tag);
      let index = byValue.get(key);
      if (index === undefined) {
        index = tags.length;
        byValue.set(key, index);
        tags.push(tag);
      }
      return index;
    });
    const { tags: _tags, ...rest } = row;
    return { ...rest, tagIds };
  });
  return { format, sessions, tags };
}

/** Decode before consumers and before cached results are re-authorized. */
export function decodeSessionTagCatalog(
  name: string | undefined,
  value: unknown,
): unknown {
  if (name !== channel || Array.isArray(value)) return value;
  if (!record(value) || value.format === undefined) return value;
  if (
    !record(value) ||
    value.format !== format ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.tags)
  )
    throw new Error("Invalid session tag catalog");
  const tags = value.tags;
  return value.sessions.map((row) => {
    if (!record(row)) throw new Error("Invalid session row");
    if (!Object.prototype.hasOwnProperty.call(row, "tagIds")) return row;
    if (
      !Array.isArray(row.tagIds) ||
      Object.prototype.hasOwnProperty.call(row, "tags")
    )
      throw new Error("Invalid session tag references");
    const resolved = row.tagIds.map((id) => {
      if (
        !Number.isInteger(id) ||
        id < 0 ||
        id >= tags.length ||
        !record(tags[id])
      )
        throw new Error("Invalid session tag reference");
      return tags[id];
    });
    const { tagIds: _ids, ...rest } = row;
    return { ...rest, tags: resolved };
  });
}
