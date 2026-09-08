import type { UpdateChannel } from '@cindy/maker-shared/update-channel';
import type { OtaRequestClient, OtaRequestTimeouts } from './otaRequestCoordinator';

export interface NativeOtaBridge {
  cindySelfHostOtaCapabilities: () => {
    version: number;
    runtimeVersion: string;
    updateUrl: string;
    available: boolean;
  };
  cindyBeginSelfHostOtaRequest: (channel: UpdateChannel) => string;
  cindyFinishSelfHostOtaRequest: (token: string) => void;
}

interface RunOptions extends OtaRequestTimeouts {
  channel: UpdateChannel;
  currentUpdateId: string | null;
  runtimeVersion: string | null;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ota-request-timeout(' + milliseconds + 'ms)')), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * The JS queue owns scheduling only. The native write-ahead journal owns header
 * restoration, downloaded candidates, successful launches and cross-process
 * recovery. A timeout does not cancel an Expo request or release this queue.
 */
export function createNativeOtaRequestCoordinator(bridge: NativeOtaBridge, client: OtaRequestClient) {
  let queue: Promise<void> = Promise.resolve();

  return {
    run<T>(options: RunOptions, operation: (client: OtaRequestClient) => Promise<T>): Promise<T> {
      const transaction = queue.then(() => {
        const capability = bridge.cindySelfHostOtaCapabilities();
        if (capability.version !== 1 || !capability.available ||
          !options.runtimeVersion || capability.runtimeVersion !== options.runtimeVersion ||
          !capability.updateUrl.startsWith('https://')) {
          // Do not fall back to the legacy full override API on an incompatible
          // or unavailable native adapter: anti-bricking intentionally forbids it.
          throw new Error('native-ota-contract-unavailable');
        }
        const token = bridge.cindyBeginSelfHostOtaRequest(options.channel);
        const requests: Promise<unknown>[] = [];
        let finished = false;
        const finish = () => {
          if (finished) return;
          bridge.cindyFinishSelfHostOtaRequest(token);
          finished = true;
        };
        const track = <R>(promise: Promise<R>, budget: number) => {
          requests.push(promise);
          return withTimeout(promise, budget);
        };
        const currentId = options.currentUpdateId?.toLowerCase();
        const coordinated: OtaRequestClient = {
          checkForUpdateAsync: async () => {
            const result = await track(client.checkForUpdateAsync(), options.checkTimeoutMs ?? 10_000);
            if (currentId && result.manifest?.id?.toLowerCase() === currentId) {
              return { ...result, isAvailable: false, manifest: undefined };
            }
            return result;
          },
          fetchUpdateAsync: async () => {
            const result = await track(client.fetchUpdateAsync(), options.fetchTimeoutMs ?? 60_000);
            if (currentId && result.manifest?.id?.toLowerCase() === currentId) {
              return { ...result, isNew: false, manifest: undefined };
            }
            return result;
          },
          reloadAsync: async () => {
            await Promise.allSettled(requests);
            // A React reload destroys this queue too. Close the request before
            // reloading; the native candidate receipt remains until CONTENT_APPEARED.
            finish();
            await client.reloadAsync();
          },
        };
        const result = Promise.resolve().then(() => operation(coordinated));
        const drained = result.then(() => undefined, () => undefined).then(async () => {
          await Promise.allSettled(requests);
          finish();
        });
        return { result, drained };
      });
      // An ordinary completed request reports restoration errors to its caller.
      // A timed-out request can fail open while native completion still drains.
      const result = transaction.then(async ({ result, drained }) => {
        const value = await result;
        await drained;
        return value;
      });
      queue = transaction.then(({ drained }) => drained).then(() => undefined, () => undefined);
      return result;
    },
  };
}
