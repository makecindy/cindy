import { executeOnce as executeCore, type TransportContext } from '@cindy/plugin-runtime/download/transport';
import { desktopDownloadRuntime } from './runtime';
export { assertDownloadUrl } from '@cindy/plugin-runtime/download/transport';
export type { TransportContext, TransportResult } from '@cindy/plugin-runtime/download/transport';
export function executeOnce(context: TransportContext) {
  return executeCore({ ...context, replaceFile: context.replaceFile ?? desktopDownloadRuntime.replaceFile,
    opts: { ...context.opts, request: context.opts.request ?? desktopDownloadRuntime.request } });
}
