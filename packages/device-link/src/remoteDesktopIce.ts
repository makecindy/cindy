/** Bounded, additive signaling inside the existing peer-authorized desktop channel. */
export interface RemoteDesktopIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string;
}
export interface RemoteDesktopIceRequest {
  op: "ice";
  lease: string;
  attemptId: string;
  candidates: RemoteDesktopIceCandidate[];
  after: number;
}
export interface RemoteDesktopIceReply {
  attemptId: string;
  candidates: RemoteDesktopIceCandidate[];
  next: number;
  complete: boolean;
}
// Independent operators; neither endpoint is a guarantee of mainland reachability.
export const REMOTE_DESKTOP_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];
// Sequential host stages, followed by transport and WebView delivery headroom.
// Keep the outer waits derived from these limits so a valid cold start is not discarded.
export const REMOTE_DESKTOP_OFFER_BUDGET = {
  captureReadyMs: 10_000,
  platformStatusMs: 8_000,
  // Windows Node-API probe: pipe open 3s, write 5s, and ready read 5s.
  platformHandshakeMs: 13_000,
  sourcesMs: 5_000,
  hostMs: 18_000,
};
export const REMOTE_DESKTOP_INVOKE_MS =
  REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs +
  REMOTE_DESKTOP_OFFER_BUDGET.platformStatusMs +
  REMOTE_DESKTOP_OFFER_BUDGET.platformHandshakeMs +
  REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs +
  REMOTE_DESKTOP_OFFER_BUDGET.hostMs + 5_000;
export const REMOTE_DESKTOP_NETWORK = {
  maxCandidates: 128,
  batchSize: 16,
  pollMs: 250,
  exchangeMs: 30_000,
  disconnectedMs: 5_000,
  answerMs: REMOTE_DESKTOP_INVOKE_MS + 2_000,
  connectMs: 15_000,
  legacyGatherMs: 5_000,
  stableMs: 30_000,
  retryMs: [1_000, 3_000, 8_000],
};
export function isDesktopAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function parseDesktopIceCandidates(
  value: unknown,
): RemoteDesktopIceCandidate[] {
  if (!Array.isArray(value) || value.length > REMOTE_DESKTOP_NETWORK.batchSize)
    throw new Error("INVALID_DESKTOP_ICE");
  return value.map((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      typeof v.candidate !== "string" ||
      !v.candidate.startsWith("candidate:") ||
      v.candidate.length > 2048 ||
      !(
        v.sdpMid === null ||
        (typeof v.sdpMid === "string" && v.sdpMid.length <= 128)
      ) ||
      !(
        v.sdpMLineIndex === null ||
        (Number.isInteger(v.sdpMLineIndex) &&
          v.sdpMLineIndex >= 0 &&
          v.sdpMLineIndex < 32)
      ) ||
      (v.sdpMid === null && v.sdpMLineIndex === null) ||
      !(
        v.usernameFragment === undefined ||
        (typeof v.usernameFragment === "string" &&
          v.usernameFragment.length <= 256)
      )
    )
      throw new Error("INVALID_DESKTOP_ICE");
    return {
      candidate: v.candidate,
      sdpMid: v.sdpMid,
      sdpMLineIndex: v.sdpMLineIndex,
      ...(v.usernameFragment === undefined
        ? {}
        : { usernameFragment: v.usernameFragment }),
    };
  });
}
export function isDesktopIceCursor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= REMOTE_DESKTOP_NETWORK.maxCandidates
  );
}
export function parseDesktopIceReply(value: unknown): RemoteDesktopIceReply {
  const v = value as RemoteDesktopIceReply | null;
  if (
    !v ||
    !isDesktopAttemptId(v.attemptId) ||
    !isDesktopIceCursor(v.next) ||
    typeof v.complete !== "boolean"
  )
    throw new Error("INVALID_DESKTOP_ICE");
  return {
    attemptId: v.attemptId,
    next: v.next,
    complete: v.complete,
    candidates: parseDesktopIceCandidates(v.candidates),
  };
}
