import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES, PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES } from '@cindy/plugin-protocol';
import {
  CINDY_PACKAGE_MANIFEST, CindyFileError, isCindyPackagePath,
  parseCindyPackageManifest, type CindyThemePackageManifest,
} from '../../shared/cindyFile';
import { readBoundedFileFollowLinks } from '../utils/readBoundedFile';
import { isZipSymbolicLinkMode } from '../cindy-brain/ghostZipPermissions';

export const CINDY_MANIFEST_MAX_BYTES = 256 * 1024;

export type InspectedCindyFile = { type: 'plugin' } | {
  type: 'theme';
  manifest: CindyThemePackageManifest;
  packageSha256: string;
  zip: JSZip;
  prefix: string;
};

/** Bounded decompression: do not allocate the complete output before checking. */
export async function readCindyZipEntry(entry: JSZip.JSZipObject, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy(): void };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        stream.destroy();
        reject(new CindyFileError('invalid'));
      } else chunks.push(chunk);
    });
    stream.on('error', () => { settled = true; reject(new CindyFileError('invalid')); });
    stream.on('end', () => { if (!settled) resolve(Buffer.concat(chunks, total)); });
  });
}

function topFolderPrefix(names: string[]): string {
  let top: string | undefined;
  for (const name of names) {
    const slash = name.indexOf('/');
    if (slash <= 0) return '';
    const first = name.slice(0, slash);
    if (top !== undefined && top !== first) return '';
    top = first;
  }
  return top ? `${top}/` : '';
}

export async function inspectCindyFile(filePath: string): Promise<InspectedCindyFile> {
  // The source is explicitly selected/opened by the user and may be a symlink,
  // as in the existing plugin importer. Read through one stable bounded handle.
  const source = await fs.realpath(filePath);
  const bytes = await readBoundedFileFollowLinks(source, PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES);
  if (!bytes) throw new CindyFileError('invalid');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new CindyFileError('invalid'); }
  const entries = Object.values(zip.files).filter(entry => !entry.name.startsWith('__MACOSX/'));
  const prefix = topFolderPrefix(entries.map(entry => entry.name));

  // ghost.json was the complete legacy contract. Do not reserve new filenames
  // inside those packages or change their validation/approval/update behavior.
  if (zip.file(`${prefix}ghost.json`)) return { type: 'plugin' };

  if (!entries.length || entries.length > PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES) throw new CindyFileError('invalid');
  const paths = new Set<string>();
  for (const entry of entries) {
    const original = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    const canonical = original.replace(/\/$/, '');
    if (!isCindyPackagePath(canonical) || original !== entry.name
      || isZipSymbolicLinkMode(entry.unixPermissions)) throw new CindyFileError('invalid');
    const folded = canonical.toLowerCase();
    if (paths.has(folded)) throw new CindyFileError('invalid');
    paths.add(folded);
  }
  const manifestEntry = zip.file(prefix + CINDY_PACKAGE_MANIFEST);
  if (!manifestEntry) throw new CindyFileError('unsupported');
  let raw: unknown;
  try { raw = JSON.parse((await readCindyZipEntry(manifestEntry, CINDY_MANIFEST_MAX_BYTES)).toString('utf8')); }
  catch { throw new CindyFileError('invalid'); }
  return {
    type: 'theme', manifest: parseCindyPackageManifest(raw), zip, prefix,
    packageSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
