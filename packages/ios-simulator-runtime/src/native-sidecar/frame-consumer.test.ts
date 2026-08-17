import { describe, expect, it } from "vitest";

import type {
  IOSSimulatorH264Frame,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import { streamIOSimulatorNativeFramesWithQueue } from "./frame-consumer.js";
import { IOSSimulatorNativeFrameQueue } from "./frame-validation.js";

function frame(sequence: number): IOSSimulatorH264Frame {
  return {
    encoding: "h264",
    format: "annex-b",
    bytes: new Uint8Array([0, 0, 0, 1, sequence === 1 ? 0x65 : 0x41, 0x88]),
    receivedAt: "2026-07-23T00:00:00.000Z",
    width: 2,
    height: 1,
    orientation: "PORTRAIT",
    scale: 1,
    colorSpace: "srgb",
    timestampMicros: sequence,
    keyFrame: sequence === 1,
  };
}

describe("native frame queue consumer", () => {
  it("keeps sidecar callbacks non-blocking and delivers the latest frame", async () => {
    const driver = {
      streamNativeFrames: async ({
        onFrame,
      }: {
        onFrame(frame: IOSSimulatorH264Frame): void;
      }) => {
        for (let sequence = 1; sequence <= 5; sequence += 1) {
          onFrame(frame(sequence));
        }
        return {
          frameCount: 5,
          byteCount: 30,
          startedAt: "2026-07-23T00:00:00.000Z",
          firstFrameAt: "2026-07-23T00:00:00.000Z",
          endedAt: "2026-07-23T00:00:01.000Z",
          endReason: "eof" as const,
        };
      },
    } as unknown as IOSSimulatorNativeSidecarDriver;
    const received: number[] = [];
    const resultPromise = streamIOSimulatorNativeFramesWithQueue(driver, {
      queue: new IOSSimulatorNativeFrameQueue({ maxFrames: 2, maxBytes: 12 }),
      onFrame: async (nativeFrame) => {
        received.push(nativeFrame.timestampMicros);
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      stats: { frameCount: 5 },
      queue: { depth: 0, droppedFrames: 3, droppedBytes: 18 },
    });
    expect(received).toEqual([1, 5]);
  });
});
