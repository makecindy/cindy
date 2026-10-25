import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import { EngineError } from './types.js';

const MAX_EXPANDED = 3 * 1024 ** 3;
export function archivePath(name: string): string {
  const normalized = name.replace(/\/$/, '');
  if (!normalized || normalized.includes('\\') || normalized.includes(':') || normalized.startsWith('/') || normalized.split('/').some(part => part === '..') || /[\x00-\x1f]/.test(normalized)) throw new EngineError('unsafe_archive_path');
  return normalized;
}

/** Archives are unpacked only in a new private staging directory. Links are not
 * permitted: no archive can redirect a later entry outside that directory. */
export async function extractEngineArchive(file: string, destination: string, format: 'tar.gz' | 'zip'): Promise<void> {
  let bytes = 0;
  let entries = 0;
  if (format === 'tar.gz') {
    let invalid: unknown;
    await tar.x({ file, cwd: destination, strict: true, preservePaths: false,
      filter(name, entry) {
        // Throwing in node-tar's parser callback escapes its Promise. Record
        // failure and reject after parsing; never write this or later entries.
        try {
          archivePath(name);
          if (!('type' in entry) || !['File', 'OldFile', 'Directory'].includes(entry.type)) throw new EngineError('unsafe_archive_entry');
          bytes += entry.size;
          if (++entries > 100_000 || bytes > MAX_EXPANDED) throw new EngineError('archive_too_large');
        } catch (error) { invalid ??= error; }
        return !invalid;
      },
    });
    if (invalid) throw invalid;
    return;
  }
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, value) => {
      if (error || !value) reject(new EngineError('invalid_archive'));
      else resolve(value);
    });
  });
  let entryWork: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (cause: unknown) => { failed = true; reject(cause); };
      zip.on('error', fail);
      zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        entryWork = (async () => {
          const name = archivePath(entry.fileName);
          const mode = entry.externalFileAttributes >>> 16;
          if ((mode & 0o170000) === 0o120000) throw new EngineError('unsafe_archive_entry');
          bytes += entry.uncompressedSize;
          if (++entries > 100_000 || bytes > MAX_EXPANDED) throw new EngineError('archive_too_large');
          const output = path.join(destination, ...name.split('/'));
          if (entry.fileName.endsWith('/')) await mkdir(output, { recursive: true, mode: 0o700 });
          else {
            await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (err, value) => err || !value ? rej(new EngineError('invalid_archive')) : res(value)));
            await pipeline(stream, createWriteStream(output, { flags: 'wx', mode: mode & 0o111 ? 0o700 : 0o600 }));
          }
          if (!failed) zip.readEntry();
        })();
        void entryWork.catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    // `end` only means that all entries were visited. Windows cannot remove
    // staging while the archive (or an output stream) still owns a file handle.
    await entryWork?.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      zip.once('close', resolve);
      zip.once('error', reject);
      zip.close();
    });
  }
}
