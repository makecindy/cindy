import { putLocalFile as putNativeFile, type PutLocalFileOptions } from '@cindy/plugin-runtime/publisher/putObject';
import { resolveOutboundDispatcher } from '../maker-host/outbound-fetch.js';
import type { FileHandle } from 'node:fs/promises';
export * from '@cindy/plugin-runtime/publisher/putObject';
export function putLocalFile(handle: FileHandle, options: PutLocalFileOptions) {
  return putNativeFile(handle, { ...options, resolveDispatcher: options.resolveDispatcher ?? resolveOutboundDispatcher });
}
