import { expect, it } from "vitest";
import {
  rtcDiagnosticSummary,
  RTC_DIAGNOSTIC_REVISION,
} from "../rtcDiagnostics";

it("projects only allowed counters and enums, excluding remote text and credentials", () => {
  expect(
    rtcDiagnosticSummary({
      stage: "config-applied",
      attemptId: "ABCDEF12-1234",
      elapsedMs: 3100,
      source: "native-deadline",
      serverCount: 2,
      turnUrlCount: 0,
      local_host: 3,
      credential: "private",
      urls: ["turn:private:3478"],
      sdp: "private",
      address: "1.2.3.4",
      reason: "secret error",
      localKind: "arbitrary remote text",
      remote_relay: NaN,
    }),
  ).toEqual({
    revision: RTC_DIAGNOSTIC_REVISION,
    stage: "config-applied",
    attempt: "ABCDEF12",
    elapsedMs: 3100,
    source: "native-deadline",
    serverCount: 2,
    turnUrlCount: 0,
    local_host: 3,
    reason: "other",
  });
  expect(rtcDiagnosticSummary({ stage: "unknown private event" })).toBeNull();
});

it("keeps candidate types and native gathering failure codes without their URLs or text", () => {
  expect(
    rtcDiagnosticSummary({
      stage: "ice-error",
      errorCode: 701,
      errorText: "private",
      url: "private",
    }),
  ).toEqual({
    revision: RTC_DIAGNOSTIC_REVISION,
    stage: "ice-error",
    errorCode: 701,
  });
  expect(
    rtcDiagnosticSummary({
      stage: "selected-pair",
      localKind: "relay",
      remoteKind: "host",
    }),
  ).toMatchObject({ localKind: "relay", remoteKind: "host" });
});
