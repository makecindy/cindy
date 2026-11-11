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

// These payloads contain host-owned settings. Never walk messages, tool results or content.
const speedChannels = /^(?:local-db:(?:sessions|bots):|maker:(?:list-active$|get-new-maker-defaults$|new-maker-draft:changed$|model-favorites:|schedule:|session-model-pref:|session-sync$))/;
const speedContainers = new Set([
  'sessions', 'session', 'items', 'value', 'patch', 'state', 'runtime',
  'runtimeBaseline', 'runtimeEffective', 'pendingMutation', 'profile',
  'effectiveProfile', 'baseline', 'modelChain', 'modelChainOverride', 'modelOverride', 'favorites',
  'capabilities', 'claudeCode', 'codex', 'pi',
]);

/** Additive wire projection: old clients keep a boolean, new clients restore the exact tier. */
export function encodeModelSpeedPayload(channel: string | undefined, value: unknown): unknown {
  return channel && speedChannels.test(channel) ? mapModelSpeed(value, false) : value;
}
export function decodeModelSpeedPayload(channel: string | undefined, value: unknown): unknown {
  return channel && speedChannels.test(channel) ? mapModelSpeed(value, true) : value;
}
function mapModelSpeed(value: unknown, decode: boolean, depth = 0): unknown {
  if (depth > 16) return value;
  if (Array.isArray(value)) {
    const next = value.map(item => mapModelSpeed(item, decode, depth + 1));
    return next.some((item, i) => item !== value[i]) ? next : value;
  }
  if (!record(value)) return value;
  let next = value;
  const write = (key: string, field: unknown) => {
    if (next === value) next = { ...value };
    next[key] = field;
  };
  for (const key of ['fastMode', 'fast'] as const) {
    const tier = `${key}Tier`;
    if (decode ? value[key] === true && value[tier] === 'ultrafast' : value[key] === 'ultrafast') {
      write(key, decode ? 'ultrafast' : true);
      if (decode) delete next[tier];
      else write(tier, 'ultrafast');
    }
  }
  for (const key of ['fastModeByModel', 'fastByModel'] as const) {
    const values = value[key];
    if (!record(values)) continue;
    const tierKey = `${key}Tiers`;
    const tiers = record(value[tierKey]) ? value[tierKey] : {};
    const mapped = { ...values };
    const mappedTiers = { ...tiers };
    let changed = false;
    for (const [model, speed] of Object.entries(values)) {
      if (decode ? speed === true && tiers[model] === 'ultrafast' : speed === 'ultrafast') {
        mapped[model] = decode ? 'ultrafast' : true;
        if (decode) delete mappedTiers[model];
        else mappedTiers[model] = 'ultrafast';
        changed = true;
      }
    }
    if (changed) {
      write(key, mapped);
      if (Object.keys(mappedTiers).length) write(tierKey, mappedTiers);
      else delete next[tierKey];
    }
  }
  const memory = value.providerModelMemory;
  if (record(memory)) {
    const slots = Object.fromEntries(Object.entries(memory)
      .map(([key, slot]) => [key, mapModelSpeed(slot, decode, depth + 1)]));
    if (Object.keys(slots).some(key => slots[key] !== memory[key])) {
      write('providerModelMemory', slots);
    }
  }
  for (const key of speedContainers) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const child = mapModelSpeed(value[key], decode, depth + 1);
    if (child !== value[key]) write(key, child);
  }
  return next;
}
