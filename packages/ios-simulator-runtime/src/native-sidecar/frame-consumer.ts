import type {
  IOSSimulatorNativeFrame,
  IOSSimulatorNativeSidecarDriver,
  IOSSimulatorStreamStats,
} from "../driver.js";
import {
  IOSSimulatorNativeFrameQueue,
  type IOSSimulatorNativeFrameQueueStats,
} from "./frame-validation.js";

export interface IOSSimulatorNativeFrameQueueConsumerOptions {
  signal?: AbortSignal;
  maxFrames?: number;
  maxFrameBytes?: number;
  queue?: IOSSimulatorNativeFrameQueue;
  onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
}

export interface IOSSimulatorNativeFrameQueueConsumerResult {
  stats: IOSSimulatorStreamStats;
  queue: IOSSimulatorNativeFrameQueueStats;
}

/**
 * Connects the bounded latest-frame queue to the native stream callback.
 * Sidecar callbacks only copy/enqueue and therefore do not let a slow renderer
 * retain unbounded native frames. The consumer is drained in order and the
 * latest frame wins when it falls behind.
 */
export async function streamIOSimulatorNativeFramesWithQueue(
  driver: IOSSimulatorNativeSidecarDriver,
  options: IOSSimulatorNativeFrameQueueConsumerOptions,
): Promise<IOSSimulatorNativeFrameQueueConsumerResult> {
  const queue = options.queue ?? new IOSSimulatorNativeFrameQueue();
  let draining: Promise<void> | null = null;
  let consumerError: unknown = null;

  const drain = async (): Promise<void> => {
    while (consumerError === null) {
      const frame = queue.takeLatest();
      if (!frame) return;
      try {
        await options.onFrame(frame);
      } catch (error) {
        consumerError = error;
        return;
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    if (!draining) {
      draining = drain().finally(() => {
        draining = null;
      });
    }
    return draining;
  };

  const stats = await driver.streamNativeFrames({
    signal: options.signal,
    maxFrames: options.maxFrames,
    maxFrameBytes: options.maxFrameBytes,
    onFrame: (frame) => {
      queue.enqueue(frame);
      void scheduleDrain();
    },
  });
  if (draining) await draining;
  if (consumerError !== null) throw consumerError;
  while (queue.stats.depth > 0) await scheduleDrain();
  return { stats, queue: queue.stats };
}
