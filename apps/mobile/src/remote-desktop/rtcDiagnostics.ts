/** The native bridge is not a license to persist arbitrary fields or remote text. */
export const RTC_DIAGNOSTIC_REVISION = "ice-diag-20260919-2";
const stages = new Set([
  "config-requested",
  "config-deadline",
  "config-received",
  "config-late-ignored",
  "config-applied",
  "answer-applied",
  "offer-sent",
  "exchange-error",
  "exchange-sent",
  "exchange-applied",
  "candidate-kind",
  "failed",
  "selected-pair",
  "gathering",
  "connection",
  "ice-state",
  "first-frame",
  "ice-error",
]);
const kinds = ["host", "srflx", "prflx", "relay", "unknown"];
const counts = [
  "serverCount",
  "turnUrlCount",
  "localAck",
  "remoteAfter",
  "exchangeId",
  "batchCount",
  ...["local", "remote"].flatMap((side) =>
    kinds.map((kind) => `${side}_${kind}`),
  ),
];

export function rtcDiagnosticSummary(message: Record<string, unknown>) {
  if (typeof message.stage !== "string" || !stages.has(message.stage))
    return null;
  const result: Record<string, string | number | boolean> = {
    revision: RTC_DIAGNOSTIC_REVISION,
    stage: message.stage,
  };
  if (typeof message.trickleEnabled === "boolean")
    result.trickleEnabled = message.trickleEnabled;
  if (
    typeof message.attemptId === "string" &&
    /^[a-z\d-]{1,80}$/i.test(message.attemptId)
  )
    result.attempt = message.attemptId.slice(0, 8);
  for (const key of [...counts, "elapsedMs", "stateCode", "errorCode"]) {
    const value = message[key];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 86_400_000
    )
      result[key] = value;
  }
  for (const key of ["localKind", "remoteKind"]) {
    if (typeof message[key] === "string" && kinds.includes(message[key]))
      result[key] = message[key];
  }
  if (message.source === "bridge" || message.source === "native-deadline")
    result.source = message.source;
  if (
    typeof message.serverKind === "string" &&
    ["stun", "turn", "turns"].includes(message.serverKind)
  )
    result.serverKind = message.serverKind;
  if (
    typeof message.transportKind === "string" &&
    ["udp", "tcp", "tls"].includes(message.transportKind)
  )
    result.transportKind = message.transportKind;
  if (typeof message.reason === "string")
    result.reason = [
      "answer",
      "offer",
      "setup",
      "host",
      "transport",
      "disconnected",
      "candidates",
      "candidate-limit",
      "connect-timeout",
      "answer-timeout",
    ].includes(message.reason)
      ? message.reason
      : "other";
  return result;
}
