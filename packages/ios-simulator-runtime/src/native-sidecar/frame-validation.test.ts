import { describe, expect, it } from "vitest";

import type {
  IOSSimulatorBgraFrame,
  IOSSimulatorH264Frame,
} from "../driver.js";
import {
  convertIOSimulatorBgraToRgba,
  IOSSimulatorNativeFrameQueue,
  IOSSimulatorNativeFrameValidationError,
  validateIOSimulatorNativeFrame,
} from "./frame-validation.js";

function bgra(bytes: Uint8Array, bytesPerRow = 8): IOSSimulatorBgraFrame {
  return {
    encoding: "bgra",
    bytes,
    receivedAt: "2026-07-23T00:00:00.000Z",
    width: 2,
    height: 1,
    orientation: "PORTRAIT",
    scale: 1,
    colorSpace: "srgb",
    bytesPerRow,
    timestampMicros: 1,
  };
}

function h264(
  bytes: Uint8Array,
  timestampMicros: number,
): IOSSimulatorH264Frame {
  const accessUnit =
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 1
      ? bytes
      : new Uint8Array([0, 0, 0, 1, 0x65, ...bytes]);
  return {
    encoding: "h264",
    format: "annex-b",
    bytes: accessUnit,
    receivedAt: "2026-07-23T00:00:00.000Z",
    width: 2,
    height: 1,
    orientation: "PORTRAIT",
    scale: 1,
    colorSpace: "srgb",
    timestampMicros,
    keyFrame: true,
  };
}

describe("native frame validation and bounded queue", () => {
  it("validates padded BGRA rows and converts BGRX to tightly packed RGBA", () => {
    const frame = bgra(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]));
    expect(validateIOSimulatorNativeFrame(frame)).toBe(frame);
    expect(convertIOSimulatorBgraToRgba(frame)).toEqual(
      new Uint8Array([30, 20, 10, 255, 60, 50, 40, 255]),
    );
  });

  it("rejects truncated rows, invalid timestamps, and oversized frames", () => {
    expect(() =>
      validateIOSimulatorNativeFrame(bgra(new Uint8Array(7))),
    ).toThrow(IOSSimulatorNativeFrameValidationError);
    expect(() =>
      validateIOSimulatorNativeFrame({
        ...h264(new Uint8Array([1]), 1),
        timestampMicros: -1,
      }),
    ).toThrow("timestamp");
    expect(() =>
      validateIOSimulatorNativeFrame(h264(new Uint8Array([1, 2]), 1), {
        maxFrameBytes: 1,
      }),
    ).toThrow("exceed");
  });

  it("keeps queue memory bounded and reports deterministic drops", () => {
    const queue = new IOSSimulatorNativeFrameQueue({
      maxFrames: 2,
      maxBytes: 14,
    });
    expect(queue.enqueue(h264(new Uint8Array([1, 2]), 1))).toBe(true);
    expect(queue.enqueue(h264(new Uint8Array([3, 4]), 2))).toBe(true);
    expect(queue.enqueue(h264(new Uint8Array([5, 6]), 3))).toBe(true);
    expect(queue.stats).toMatchObject({
      depth: 2,
      byteCount: 14,
      droppedFrames: 1,
      droppedBytes: 7,
    });
    expect((queue.takeLatest() as IOSSimulatorH264Frame).timestampMicros).toBe(
      3,
    );
    expect(queue.stats).toMatchObject({
      depth: 0,
      byteCount: 0,
      droppedFrames: 2,
    });
  });

  it("drops an individual frame that exceeds the queue byte budget", () => {
    const queue = new IOSSimulatorNativeFrameQueue({
      maxFrames: 2,
      maxBytes: 6,
    });
    expect(queue.enqueue(h264(new Uint8Array([1, 2]), 1))).toBe(false);
    expect(queue.stats).toMatchObject({
      depth: 0,
      droppedFrames: 1,
      droppedBytes: 7,
    });
  });

  it("validates Annex-B and length-prefixed access units", () => {
    const annexB = h264(new Uint8Array([0, 0, 0, 1, 0x65, 0x88]), 1);
    expect(validateIOSimulatorNativeFrame(annexB)).toBe(annexB);
    const lengthPrefixed: IOSSimulatorH264Frame = {
      ...annexB,
      format: "length-prefixed",
      bytes: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]),
    };
    expect(validateIOSimulatorNativeFrame(lengthPrefixed)).toBe(lengthPrefixed);
    expect(() =>
      validateIOSimulatorNativeFrame({
        ...annexB,
        keyFrame: true,
        bytes: new Uint8Array([0, 0, 0, 1, 0x41, 0x88]),
      }),
    ).toThrow("IDR");
  });
});
