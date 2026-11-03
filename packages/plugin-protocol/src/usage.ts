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
