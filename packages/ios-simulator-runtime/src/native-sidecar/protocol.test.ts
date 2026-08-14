import { describe, expect, it } from "vitest";

import {
  decodeIOSSimulatorNativeSidecarJson,
  decodeIOSSimulatorNativeSidecarStreamFrame,
  encodeIOSSimulatorNativeSidecarJson,
  encodeIOSSimulatorNativeSidecarStreamFrame,
  IOSSimulatorNativeSidecarFrameDecoder,
  IOSSimulatorNativeSidecarMessageKind,
  IOSSimulatorNativeSidecarProtocolError,
} from "./protocol.js";

describe("IOSSimulator native sidecar framed protocol", () => {
  it("decodes fragmented and coalesced frames without relying on stdout chunks", () => {
    const first = encodeIOSSimulatorNativeSidecarJson({ id: "one", ok: true });
    const second = encodeIOSSimulatorNativeSidecarJson({ id: "two", ok: true });
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);
    const decoder = new IOSSimulatorNativeSidecarFrameDecoder();

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(combined.subarray(3));
    expect(frames).toHaveLength(2);
    expect(decodeIOSSimulatorNativeSidecarJson(frames[0]!)).toMatchObject({
      id: "one",
    });
    expect(decodeIOSSimulatorNativeSidecarJson(frames[1]!)).toMatchObject({
      id: "two",
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  it("fails closed on unknown kinds, oversized declarations and truncation", () => {
    const unknownKind = new Uint8Array([0, 0, 0, 0, 255]);
    const unknownDecoder = new IOSSimulatorNativeSidecarFrameDecoder();
    expect(() => unknownDecoder.push(unknownKind)).toThrow(
      IOSSimulatorNativeSidecarProtocolError,
    );
    expect(() => unknownDecoder.push(new Uint8Array())).toThrow(
      "already failed",
    );

    const oversized = new Uint8Array([9, 0, 0, 0, 1]);
    const boundedDecoder = new IOSSimulatorNativeSidecarFrameDecoder({
      jsonBytes: 8,
    });
    expect(() => boundedDecoder.push(oversized)).toThrow("limit is 8");

    const truncated = new IOSSimulatorNativeSidecarFrameDecoder();
    const frame = encodeIOSSimulatorNativeSidecarJson({ ready: true });
    truncated.push(frame.subarray(0, frame.length - 1));
    expect(() => truncated.finish()).toThrow("inside a framed message");
  });

  it("round-trips bounded stream metadata separately from binary frame bytes", () => {
    const encoded = encodeIOSSimulatorNativeSidecarStreamFrame(
      {
        streamId: "stream-1",
        simulatorUdid: "UDID-1",
        generation: 7,
        sequence: 9,
        encoding: "h264",
        h264Format: "annex-b",
        width: 393,
        height: 852,
        orientation: "PORTRAIT",
        scale: 3,
        colorSpace: "srgb",
        timestampMicros: 123_456,
        keyFrame: true,
      },
      new Uint8Array([0, 0, 0, 1, 103]),
    );
    const decoder = new IOSSimulatorNativeSidecarFrameDecoder();
    const [frame] = decoder.push(encoded);

    expect(frame?.kind).toBe(IOSSimulatorNativeSidecarMessageKind.StreamFrame);
    expect(decodeIOSSimulatorNativeSidecarStreamFrame(frame!)).toEqual({
      metadata: {
        streamId: "stream-1",
        simulatorUdid: "UDID-1",
        generation: 7,
        sequence: 9,
        encoding: "h264",
        h264Format: "annex-b",
        width: 393,
        height: 852,
        orientation: "PORTRAIT",
        scale: 3,
        colorSpace: "srgb",
        timestampMicros: 123_456,
        keyFrame: true,
      },
      bytes: new Uint8Array([0, 0, 0, 1, 103]),
    });
  });

  it("rejects malformed and non-object JSON envelopes", () => {
    expect(() => encodeIOSSimulatorNativeSidecarJson(undefined)).toThrow(
      "not serializable",
    );
    expect(() =>
      decodeIOSSimulatorNativeSidecarJson({
        kind: IOSSimulatorNativeSidecarMessageKind.Json,
        body: new TextEncoder().encode("not-json"),
      }),
    ).toThrow("malformed JSON");
    expect(() =>
      decodeIOSSimulatorNativeSidecarJson({
        kind: IOSSimulatorNativeSidecarMessageKind.Json,
        body: new TextEncoder().encode("[]"),
      }),
    ).toThrow("must be an object");
  });

  it("rejects impossible BGRA metadata before exposing frame bytes", () => {
    const encoded = encodeIOSSimulatorNativeSidecarStreamFrame(
      {
        streamId: "stream-1",
        simulatorUdid: "UDID-1",
        generation: 1,
        sequence: 1,
        encoding: "bgra",
        width: 100,
        height: 100,
        orientation: "PORTRAIT",
        scale: 1,
        colorSpace: "srgb",
        bytesPerRow: 100,
        timestampMicros: 1,
      },
      new Uint8Array([1]),
    );
    const [frame] = new IOSSimulatorNativeSidecarFrameDecoder().push(encoded);
    expect(() => decodeIOSSimulatorNativeSidecarStreamFrame(frame!)).toThrow(
      "metadata is invalid",
    );
  });
});
