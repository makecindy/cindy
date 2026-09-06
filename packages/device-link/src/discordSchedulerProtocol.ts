/**
 * Dormant Discord scheduler payload shared by Device Link clients.
 *
 * The relay treats this push payload as opaque, but its topic, bounds, and
 * validation belong beside the other Device Link tunnel contracts so every
 * client uses the same wire shape.
 */

/** Device Link push topic reserved for the Discord-only scheduler adapter. */
export const IM_SCHEDULER_PUSH_CHANNEL = "cindy:discord-scheduler:v1";
export const MAX_RUNTIME_GAPS = 8;

export interface SchedulerChannelIdentity {
  channel: "discord";
  /** Discord application id only; credentials never belong in this type. */
  identity: string;
}

export interface SchedulerChannelBinding extends SchedulerChannelIdentity {
  /** Opaque lifecycle fence rotated whenever this Desktop's binding changes. */
  bindingGeneration: string;
}

export interface SchedulerRuntimeFrame {
  identity: string;
  /**
   * Recipient binding lifecycle for which this runtime state is valid. A peer
   * must not relabel an older gap when the recipient advertises a new binding.
   */
  bindingGeneration: string;
  generation: string;
  state: "active" | "dirty" | "clean";
  predecessor?: string;
}

export interface SchedulerAdvertisementFrame {
  kind: "advertisement";
  sentAt: number;
  channels: readonly SchedulerChannelBinding[];
  runtime?: SchedulerRuntimeFrame;
  runtimeGaps?: readonly SchedulerRuntimeFrame[];
  /** Matches the discovery probe that caused this advertisement. */
  inReplyTo?: string;
}

export interface SchedulerProbeFrame {
  kind: "probe";
  sentAt: number;
  nonce: string;
  channels: readonly SchedulerChannelBinding[];
  runtime?: SchedulerRuntimeFrame;
  runtimeGaps?: readonly SchedulerRuntimeFrame[];
}

export type ImSchedulerFrame =
  SchedulerAdvertisementFrame | SchedulerProbeFrame;

const DISCORD_ID_PATTERN = /^[1-9][0-9]{16,19}$/;
const RUNTIME_GENERATION_PATTERN = /^[a-f0-9]{32}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function isWithinSchedulerFrameSize(value: unknown): boolean {
  let size = 0;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return false;
  }
  return size <= 8_192;
}

export function isSchedulerChannelIdentity(
  value: unknown,
): value is SchedulerChannelIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    Object.keys(identity).length === 2 &&
    identity.channel === "discord" &&
    typeof identity.identity === "string" &&
    DISCORD_ID_PATTERN.test(identity.identity)
  );
}

export function isSchedulerChannelBinding(
  value: unknown,
): value is SchedulerChannelBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    Object.keys(binding).length === 3 &&
    binding.channel === "discord" &&
    typeof binding.identity === "string" &&
    DISCORD_ID_PATTERN.test(binding.identity) &&
    typeof binding.bindingGeneration === "string" &&
    NONCE_PATTERN.test(binding.bindingGeneration)
  );
}

export function isSchedulerRuntimeFrame(
  value: unknown,
): value is SchedulerRuntimeFrame {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Record<string, unknown>;
  if (
    Object.keys(runtime).some(
      (key) =>
        ![
          "identity",
          "bindingGeneration",
          "generation",
          "state",
          "predecessor",
        ].includes(key),
    )
  ) {
    return false;
  }
  if (
    typeof runtime.identity !== "string" ||
    !DISCORD_ID_PATTERN.test(runtime.identity)
  )
    return false;
  if (
    typeof runtime.bindingGeneration !== "string" ||
    !NONCE_PATTERN.test(runtime.bindingGeneration)
  ) {
    return false;
  }
  if (
    typeof runtime.generation !== "string" ||
    !RUNTIME_GENERATION_PATTERN.test(runtime.generation)
  ) {
    return false;
  }
  if (
    runtime.state !== "active" &&
    runtime.state !== "dirty" &&
    runtime.state !== "clean"
  )
    return false;
  if (
    runtime.predecessor !== undefined &&
    (runtime.state !== "active" ||
      typeof runtime.predecessor !== "string" ||
      !RUNTIME_GENERATION_PATTERN.test(runtime.predecessor) ||
      runtime.predecessor === runtime.generation)
  )
    return false;
  return true;
}

function isRuntimeGapList(
  value: unknown,
): value is readonly SchedulerRuntimeFrame[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_GAPS) return false;
  const generations = new Set<string>();
  return value.every((runtime) => {
    if (!isSchedulerRuntimeFrame(runtime) || runtime.state !== "dirty")
      return false;
    const key = `${runtime.identity}\u0000${runtime.bindingGeneration}\u0000${runtime.generation}`;
    if (generations.has(key)) return false;
    generations.add(key);
    return true;
  });
}

export function isImSchedulerFrame(value: unknown): value is ImSchedulerFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (typeof frame.sentAt !== "number" || !Number.isFinite(frame.sentAt))
    return false;

  if (frame.kind === "probe") {
    if (
      Object.keys(frame).some(
        (key) =>
          ![
            "kind",
            "sentAt",
            "nonce",
            "channels",
            "runtime",
            "runtimeGaps",
          ].includes(key),
      )
    ) {
      return false;
    }
    const valid =
      typeof frame.nonce === "string" &&
      NONCE_PATTERN.test(frame.nonce) &&
      Array.isArray(frame.channels) &&
      frame.channels.length <= 1 &&
      frame.channels.every(isSchedulerChannelBinding) &&
      (frame.runtime === undefined || isSchedulerRuntimeFrame(frame.runtime)) &&
      isRuntimeGapList(frame.runtimeGaps);
    return valid && isWithinSchedulerFrameSize(value);
  }

  if (frame.kind !== "advertisement") return false;
  if (
    Object.keys(frame).some(
      (key) =>
        ![
          "kind",
          "sentAt",
          "channels",
          "runtime",
          "runtimeGaps",
          "inReplyTo",
        ].includes(key),
    )
  ) {
    return false;
  }
  const valid =
    Array.isArray(frame.channels) &&
    frame.channels.length <= 1 &&
    frame.channels.every(isSchedulerChannelBinding) &&
    (frame.runtime === undefined || isSchedulerRuntimeFrame(frame.runtime)) &&
    isRuntimeGapList(frame.runtimeGaps) &&
    (frame.inReplyTo === undefined ||
      (typeof frame.inReplyTo === "string" &&
        NONCE_PATTERN.test(frame.inReplyTo)));
  return valid && isWithinSchedulerFrameSize(value);
}
