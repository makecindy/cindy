/**
 * One-at-a-time lanes keyed by remote device.
 *
 * Background reads for several visible rows on the same remote computer (PR references
 * and PR statuses) used to leave together on every refresh tick and focus: three or four
 * ~1.3 s requests to one device at once, filling the controller's background invoke slots
 * and that device's admission budget while the user may be sending a message. A lane
 * runs them back to back instead. Each request still has its own device-link timeout, so
 * a stuck one releases the lane when it fails.
 */
export interface DeviceLanes {
  run<T>(deviceId: string, task: () => Promise<T>): Promise<T>;
}

export function createDeviceLanes(): DeviceLanes {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(deviceId);
      // An idle lane starts at once, so a lone read keeps its original timing.
      const result = previous ? previous.then(task, task) : startNow(task);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(deviceId, tail);
      void tail.then(() => {
        if (tails.get(deviceId) === tail) tails.delete(deviceId);
      });
      return result;
    },
  };
}

function startNow<T>(task: () => Promise<T>): Promise<T> {
  try {
    return task();
  } catch (error) {
    return Promise.reject(error);
  }
}
