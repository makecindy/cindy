import { createLogger } from '../logger';
import { requestResponse } from './http';
import { replaceFile } from '../utils/replaceFile';
import type { SchedulerOptions } from '@cindy/plugin-runtime/download/scheduler';
const log = createLogger('scheduler');
/** Desktop keeps its existing proxy, logging and Windows publication adapters. */
export const desktopDownloadRuntime: Omit<SchedulerOptions, 'maxConcurrent'> = {
  request: async (url, init) => ({ response: await requestResponse(url, init) }),
  replaceFile,
  logger: {
    warn: (message, meta) => log.warn(message, meta ?? ''),
    info: (message, meta) => log.info(message, meta ?? ''),
    error: (message, meta) => log.error(message, meta ?? ''),
    debug() {},
  },
};
