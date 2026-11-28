import { PluginProtocolError } from "./internal/parse.js";

export interface PluginUsageEventInput {
  eventId: string;
  releaseId: string;
  occurredAt: string;
}

export const PLUGIN_USAGE_REJECTION_CODES = [
  "EVENT_ID_CONFLICT",
  "RELEASE_NOT_DELIVERED",
  "OCCURRED_AT_OUT_OF_RANGE",
] as const;

export interface PluginUsageAck {
  accepted: string[];
  duplicate: string[];
  rejected: { eventId: string; code: string }[];
}

/** Acknowledgements only apply to this exact batch. Missing IDs remain pending. */
export function parsePluginUsageAck(
  value: unknown,
  expectedIds: readonly string[],
): PluginUsageAck {
  const fail = (): never => {
    throw new PluginProtocolError("Invalid plugin usage acknowledgement");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const raw = value as Record<string, unknown>;
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const id = (value: unknown): string => {
    if (typeof value !== "string" || !expected.has(value) || seen.has(value))
      return fail();
    seen.add(value);
    return value;
  };
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > expected.size) return fail();
    return value.map(id);
  };
  const accepted = ids(raw.accepted);
  const duplicate = ids(raw.duplicate);
  if (!Array.isArray(raw.rejected) || raw.rejected.length > expected.size)
    return fail();
  const rejected = raw.rejected.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail();
    const row = value as Record<string, unknown>;
    if (typeof row.code !== "string" || !/^[A-Z_]{1,64}$/.test(row.code))
      return fail();
    return { eventId: id(row.eventId), code: row.code };
  });
  return { accepted, duplicate, rejected };
}

export const PLUGIN_USAGE_BUCKET_FORMAT = "usage-buckets-v1";
export const PLUGIN_USAGE_BUCKET_MS = 600_000;
export const PLUGIN_USAGE_BUCKET_MAX_COUNT = 2_147_483_647;
export const PLUGIN_USAGE_BATCH_MAX_ITEMS = 100;
export const PLUGIN_USAGE_BATCH_MAX_BYTES = 65_536;

export interface PluginUsageBucket {
  eventId: string;
  releaseId: string;
  bucketStart: string;
  count: number;
}

export interface PluginUsageBucketAck {
  accepted: { eventId: string; count: number }[];
  duplicate: { eventId: string; count: number }[];
  rejected: PluginUsageAck["rejected"];
}

export function parsePluginUsageBucketAck(
  value: unknown,
  buckets: readonly PluginUsageBucket[],
): PluginUsageBucketAck {
  const fail = (): never => { throw new PluginProtocolError("Invalid plugin usage bucket acknowledgement"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (raw.format !== PLUGIN_USAGE_BUCKET_FORMAT) return fail();
  const expected = new Map(buckets.map(bucket => [bucket.eventId, bucket.count]));
  const readCounts = (value: unknown): { eventId: string; count: number }[] => {
    if (!Array.isArray(value) || value.length > expected.size) return fail();
    return value.map(item => {
      if (!item || typeof item.eventId !== "string" || !expected.has(item.eventId) ||
          !Number.isSafeInteger(item.count) || item.count !== expected.get(item.eventId)) return fail();
      return { eventId: item.eventId, count: item.count };
    });
  };
  const accepted = readCounts(raw.accepted);
  const duplicate = readCounts(raw.duplicate);
  const { rejected } = parsePluginUsageAck({
    accepted: accepted.map(item => item.eventId),
    duplicate: duplicate.map(item => item.eventId),
    rejected: raw.rejected,
  }, [...expected.keys()]);
  return { accepted, duplicate, rejected };
}
