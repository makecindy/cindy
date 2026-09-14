export type SpawnedHelperProcess = {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

export function waitForSpawnedProcess<T extends SpawnedHelperProcess>(
  child: T,
  onLateError?: (error: Error) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.off('error', onError);
      child.on('error', (error) => {
        onLateError?.(error);
      });
      resolve(child);
    });
  });
}

export function assertHelperCommandSucceeded(result: {
  ok?: boolean;
  error?: string | null;
  reason?: string;
}): void {
  if (result.ok === false) {
    throw new Error(result.error || result.reason || 'macOS helper command failed');
  }
}
