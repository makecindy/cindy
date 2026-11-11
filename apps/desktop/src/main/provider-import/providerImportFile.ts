import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAX_PROVIDER_IMPORT_FILE_BYTES } from './providerImport.js';

/** Only called with the path returned by Main's native picker; never accepts an IPC path. */
export async function readProviderImportFile(filePath: string): Promise<Buffer> {
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throwIpcError('PROVIDER_IMPORT_FILE_INVALID', 'expected a regular JSON file');
      if (stat.size > MAX_PROVIDER_IMPORT_FILE_BYTES)
        throwIpcError('PROVIDER_IMPORT_FILE_TOO_LARGE', 'provider import file exceeds 4 MiB');
      // A file can grow after stat. Read at most the budget plus one sentinel byte.
      const buffer = Buffer.alloc(MAX_PROVIDER_IMPORT_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_PROVIDER_IMPORT_FILE_BYTES)
        throwIpcError('PROVIDER_IMPORT_FILE_TOO_LARGE', 'provider import file exceeds 4 MiB');
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isIpcError(error)) throw error;
    // fs errors contain local paths; neither paths nor file contents cross IPC or enter logs.
    throwIpcError('PROVIDER_IMPORT_FILE_READ_FAILED', 'could not read provider import file');
  }
}
