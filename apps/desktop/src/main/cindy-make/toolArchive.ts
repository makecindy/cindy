import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import * as tar from 'tar';
import type { MakeToolArtifact } from './toolCatalog.js';

const MAX_ARCHIVE_BYTES = 160 * 1024 ** 2;
const MAX_FILE_BYTES = 256 * 1024 ** 2;
const MAX_EXPANDED_BYTES = 1024 ** 3;
const MAX_ENTRIES = 30_000;

/** Publisher paths are POSIX paths, independent of the host extracting the archive. */
export function safeArchivePath(name: string): string {
  const clean = name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (
    !clean ||
    /[\\:\0]/.test(clean) ||
    path.posix.isAbsolute(clean) ||
    clean.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    throw new Error('Unsafe tool archive path');
  }
  return clean;
}

export function safeArchiveLink(name: string, link: string, hard: boolean): void {
  safeArchivePath(name);
  if (!link || /[\\:\0]/.test(link) || path.posix.isAbsolute(link))
    throw new Error('Unsafe tool archive link');
  safeArchivePath(path.posix.join(hard ? '' : path.posix.dirname(name), link));
}

/** Extract only hash-verified publisher artifacts into a fresh, unreferenced directory.
 * tar handles internal symlinks (Python/Node); ZIP symlinks are not needed by our catalog.
 * Preflight tar entries before any write; bound ZIP expansion while streaming each file.
 */
export async function extractMakeToolArchive(
  archive: string,
  destination: string,
  artifact: Pick<MakeToolArtifact, 'format' | 'executable'>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) throw new Error('Tool archive too large');
  if (artifact.format === 'binary') {
    await copyFile(archive, path.join(destination, artifact.executable));
  } else if (artifact.format === 'zip') {
    const zip = await JSZip.loadAsync(await readFile(archive));
    const entries = Object.values(zip.files);
    if (entries.length > MAX_ENTRIES) throw new Error('Too many tool archive entries');
    let expanded = 0;
    for (const entry of entries) {
      signal.throwIfAborted();
      const name = safeArchivePath(entry.name);
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName;
      if (original && safeArchivePath(original) !== name)
        throw new Error('Unsafe tool archive path');
      if (
        typeof entry.unixPermissions === 'number' &&
        (entry.unixPermissions & 0o170000) === 0o120000
      )
        throw new Error('Unsupported ZIP link');
      const target = path.join(destination, ...name.split('/'));
      if (entry.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          expanded += chunk.length;
          callback(
            size > MAX_FILE_BYTES || expanded > MAX_EXPANDED_BYTES
              ? new Error('Tool archive too large')
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        entry.nodeStream(),
        limit,
        createWriteStream(target, { flags: 'wx', mode: 0o644 }),
        { signal },
      );
    }
  } else {
    let count = 0;
    let expanded = 0;
    let invalid: Error | undefined;
    const listing = tar.t({
      strict: true,
      onReadEntry(entry) {
        try {
          // A harmless top-level './' directory is used by some tar publishers.
          if (entry.type === 'Directory' && /^\.(\/)?$/.test(entry.path)) return;
          safeArchivePath(entry.path);
          if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type))
            throw new Error('Unsupported tool archive entry');
          if (entry.type === 'SymbolicLink' || entry.type === 'Link')
            safeArchiveLink(entry.path, entry.linkpath ?? '', entry.type === 'Link');
          expanded += entry.size;
          if (++count > MAX_ENTRIES || entry.size > MAX_FILE_BYTES || expanded > MAX_EXPANDED_BYTES)
            throw new Error('Tool archive too large');
        } catch (error) {
          invalid = error as Error;
        }
      },
    });
    await pipeline(createReadStream(archive), listing, { signal });
    if (invalid) throw invalid;
    const extracting = tar.x({
      cwd: destination,
      strict: true,
      preservePaths: false,
      noMtime: true,
    });
    await pipeline(createReadStream(archive), extracting, { signal });
  }
  signal.throwIfAborted();
}
