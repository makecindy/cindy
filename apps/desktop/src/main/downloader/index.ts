import { createDownloadService, createDownloader as createCoreDownloader } from '@cindy/plugin-runtime/download/index';
import { desktopDownloadRuntime } from './runtime';
export * from '@cindy/plugin-runtime/download/types';
const service = createDownloadService(desktopDownloadRuntime);
export const download = service.download;
export const cleanup = service.cleanup;
export const getActive = service.getActive;
export const createDownloader = () => createCoreDownloader(desktopDownloadRuntime);
