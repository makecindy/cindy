import type { promises as fs } from 'node:fs';
import { operationCheckpoint, operationWait } from './operationBudget';

/**
 * Snapshot reads may stop waiting on a stalled filesystem. Native filesystem
 * requests cannot be killed; their late results are discarded. Temporary-file
 * writes retain their owner/finally cleanup instead of racing the write.
 */
export function operationFileSystem(native: typeof fs): typeof fs {
  const reads = new Set(['access', 'lstat', 'stat', 'realpath', 'readdir', 'readFile']);
  return new Proxy(native, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || key === 'rm') return value;
      return (...args: unknown[]) => {
        operationCheckpoint();
        const result = Reflect.apply(value, target, args);
        return reads.has(String(key)) ? operationWait(result) : result;
      };
    },
  });
}
