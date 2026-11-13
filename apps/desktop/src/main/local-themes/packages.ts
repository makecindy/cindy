import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES } from '@cindy/plugin-protocol';
import { CINDY_PACKAGE_MANIFEST, CindyFileError, isCindyPackagePath, parseCindyPackageManifest, type CindyThemePackageManifest } from '../../shared/cindyFile';
import { parseLocalThemeDocument, type LocalThemeDocument } from '../../shared/local-themes';
import { appearanceResourceReferences, type AppearanceResourceDefinition } from '../../shared/appearanceDefinition';
import { APPEARANCE_RESOURCE_MAX_BYTES, inspectAppearanceResource, prepareAppearanceResource } from '../appearance/resources';
import { CINDY_MANIFEST_MAX_BYTES, readCindyZipEntry, type InspectedCindyFile } from '../cindy-files/reader';
import { atomicWriteFileSync } from '../utils/atomicWriteFile';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { isRealPathWithinRoot, readBoundedFileNoFollow, readBoundedFileNoFollowSync } from '../utils/readBoundedFile';

const PACKAGES_DIR = '.packages';
const INSTALL_INDEX = 'installed.json';
const INDEX_MAX_BYTES = 1024 * 1024;

interface InstalledThemeReference {
  id: string;
  packageSha256: string;
  themePath: string;
}
const THEME_MAX_BYTES = 1024 * 1024;
export const THEME_BRAND_MAX_BYTES = 20 * 1024 * 1024;
export const THEME_BRAND_MAX_PIXELS = 8_000_000;

export type PackagedThemeEntry = { file: string; theme: LocalThemeDocument; assetRoot: string; packageSha256: string } | { file: string; error: string };

/** Only the user's themes root may be redirected, never managed child paths. */
function packageFilePath(root: string, relative: string): string {
  if (!isCindyPackagePath(relative)) throw new CindyFileError('invalid');
  let current = root;
  const parts = relative.split('/');
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new CindyFileError('invalid');
    }
  }
  if (!isRealPathWithinRoot(fs.realpathSync.native(current), root)) throw new CindyFileError('invalid');
  return current;
}

function packageDirectory(parent: string, name: string): string {
  const dir = path.join(parent, name);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CindyFileError('invalid');
  const real = fs.realpathSync.native(dir);
  if (!isRealPathWithinRoot(real, parent)) throw new CindyFileError('invalid');
  return real;
}

function parseTheme(raw: unknown, manifest: CindyThemePackageManifest): LocalThemeDocument {
  try {
    const theme = parseLocalThemeDocument(raw, true);
    if (theme.appearance && manifest.formatVersion !== 2) throw new CindyFileError('invalid');
    for (const asset of Object.values(theme.brand ?? {})) {
      if (!isCindyPackagePath(asset)) throw new CindyFileError('invalid');
    }
    for (const ref of appearanceResourceReferences(theme.appearance ?? {})) {
      const resource = manifest.resources?.find(r => `asset:${r.id}` === ref.reference);
      if (!resource || (ref.kind === 'wallpaper' ? resource.kind === 'font' : resource.kind !== ref.kind)) throw new CindyFileError('invalid');
    }
    return theme;
  } catch { throw new CindyFileError('invalid'); }
}

function checkVariants(themes: LocalThemeDocument[]): void {
  const ids = new Set<string>();
  const variants = new Set<string>();
  for (const theme of themes) {
    const variant = JSON.stringify([theme.family ? 'family' : 'id', theme.family ?? theme.id, theme.type]);
    if (ids.has(theme.id) || variants.has(variant)) throw new CindyFileError('invalid');
    ids.add(theme.id);
    variants.add(variant);
  }
}

/** Current references are the only installation state; palettes stay in their documents. */
function readInstalledReferences(packages: string): InstalledThemeReference[] {
  let bytes: Buffer | undefined;
  // Match atomicWriteFileSync's Windows backup-exchange protocol. A reader may
  // observe the previous committed snapshot while the primary is being replaced.
  for (const name of [INSTALL_INDEX, `${INSTALL_INDEX}.bak`]) {
    try {
      const content = readBoundedFileNoFollowSync(path.join(packages, name), INDEX_MAX_BYTES, { containWithin: packages });
      if (!content) throw new CindyFileError('invalid');
      bytes = content;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!bytes) return [];
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!parsed || parsed.formatVersion !== 1 || !Array.isArray(parsed.themes)) throw new CindyFileError('invalid');
  const ids = new Set<string>();
  return parsed.themes.map((entry: unknown): InstalledThemeReference => {
    if (!entry || typeof entry !== 'object') throw new CindyFileError('invalid');
    const ref = entry as InstalledThemeReference;
    if (typeof ref.id !== 'string' || !ref.id.trim() || ids.has(ref.id)
      || typeof ref.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.packageSha256)
      || !isCindyPackagePath(ref.themePath)) throw new CindyFileError('invalid');
    ids.add(ref.id);
    return { id: ref.id, packageSha256: ref.packageSha256, themePath: ref.themePath };
  });
}

/** Read canonical active documents; runtime metadata is never persisted. */
export function readPackagedThemesSync(themesDir: string): PackagedThemeEntry[] {
  const result: PackagedThemeEntry[] = [];
  const root = fs.realpathSync.native(themesDir);
  let packages: string;
  let installed: InstalledThemeReference[];
  try {
    packages = packageDirectory(root, PACKAGES_DIR);
    installed = readInstalledReferences(packages);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    return [{ file: path.join(PACKAGES_DIR, INSTALL_INDEX), error: 'Cannot read installed theme references.' }];
  }
  const byPackage = new Map<string, InstalledThemeReference[]>();
  for (const ref of installed) {
    const group = byPackage.get(ref.packageSha256) ?? [];
    group.push(ref);
    byPackage.set(ref.packageSha256, group);
  }
  for (const [hash, references] of byPackage) {
    const file = path.join(PACKAGES_DIR, hash, CINDY_PACKAGE_MANIFEST);
    try {
      const dir = packageDirectory(packages, hash);
      const manifestBytes = readBoundedFileNoFollowSync(packageFilePath(dir, CINDY_PACKAGE_MANIFEST), CINDY_MANIFEST_MAX_BYTES, { containWithin: dir });
      if (!manifestBytes) throw new CindyFileError('invalid');
      const manifest = parseCindyPackageManifest(JSON.parse(manifestBytes.toString('utf8')));
      const themes = references.map(ref => {
        if (!manifest.themes.includes(ref.themePath)) throw new CindyFileError('invalid');
        const bytes = readBoundedFileNoFollowSync(packageFilePath(dir, ref.themePath), THEME_MAX_BYTES, { containWithin: dir });
        if (!bytes) throw new CindyFileError('invalid');
        const theme = parseTheme(JSON.parse(bytes.toString('utf8')), manifest);
        if (theme.id !== ref.id) throw new CindyFileError('invalid');
        return theme;
      });
      checkVariants(themes);
      for (const resource of manifest.resources ?? []) {
        const size = fs.statSync(packageFilePath(dir, resource.path)).size;
        if (!size || size > APPEARANCE_RESOURCE_MAX_BYTES[resource.kind]) throw new CindyFileError('invalid');
      }
      const entries = themes.map((theme, i): PackagedThemeEntry => ({
        file: path.join(PACKAGES_DIR, hash, references[i].themePath),
        assetRoot: dir,
        packageSha256: hash,
        theme: {
          ...theme,
          ...(theme.brand ? { brand: Object.fromEntries(Object.entries(theme.brand).map(([key, relative]) => [key, packageFilePath(dir, relative)])) } : {}),
        },
      }));
      result.push(...entries);
    } catch {
      result.push({ file, error: 'Invalid or unsupported installed theme package.' });
    }
  }
  return result;
}

/** Prepare and validate entirely before publishing a content-addressed package. */
export async function installThemePackage(
  inspected: Extract<InspectedCindyFile, { type: 'theme' }>,
  themesDir: string,
  assertCurrent: () => void = () => {},
): Promise<string[]> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const read = async (relative: string, limit: number): Promise<Buffer> => {
    const cached = files.get(relative);
    if (cached) {
      if (cached.length > limit) throw new CindyFileError('invalid');
      return cached;
    }
    const entry = inspected.zip.file(inspected.prefix + relative);
    if (!entry) throw new CindyFileError('invalid');
    const bytes = await readCindyZipEntry(entry, Math.min(limit, PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES - total));
    if (!bytes.length) throw new CindyFileError('invalid');
    total += bytes.length;
    files.set(relative, bytes);
    return bytes;
  };
  await read(CINDY_PACKAGE_MANIFEST, CINDY_MANIFEST_MAX_BYTES);
  const themes: LocalThemeDocument[] = [];
  const checkedBrands = new Set<string>();
  for (const relative of inspected.manifest.themes) {
    let raw: unknown;
    try { raw = JSON.parse((await read(relative, THEME_MAX_BYTES)).toString('utf8')); }
    catch { throw new CindyFileError('invalid'); }
    const theme = parseTheme(raw, inspected.manifest);
    for (const asset of Object.values(theme.brand ?? {})) {
      const bytes = await read(asset, THEME_BRAND_MAX_BYTES);
      if (checkedBrands.has(asset)) continue;
      try {
        const { default: sharp } = await import('sharp');
        const metadata = await sharp(bytes, { limitInputPixels: THEME_BRAND_MAX_PIXELS }).metadata();
        if (!metadata.width || !metadata.height || metadata.width * metadata.height > THEME_BRAND_MAX_PIXELS) throw new CindyFileError('invalid');
      } catch { throw new CindyFileError('invalid'); }
      checkedBrands.add(asset);
    }
    themes.push(theme);
  }
  checkVariants(themes);
  try {
    for (const resource of inspected.manifest.resources ?? []) {
      await prepareAppearanceResource(await read(resource.path, APPEARANCE_RESOURCE_MAX_BYTES[resource.kind]), resource.kind);
    }
  } catch { throw new CindyFileError('invalid'); }
  // A file cannot also be an ancestor directory on any supported platform.
  for (const relative of files.keys()) {
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join('/'))) throw new CindyFileError('invalid');
    }
  }
  assertCurrent();
  await fs.promises.mkdir(themesDir, { recursive: true });
  const root = await fs.promises.realpath(themesDir);
  await fs.promises.mkdir(path.join(root, PACKAGES_DIR), { recursive: true, mode: 0o700 });
  const packages = packageDirectory(root, PACKAGES_DIR);
  return withCrossProcessLock(path.join(packages, 'install.lock'), { label: 'theme-install' }, async (status) => {
    if (!status.held) throw new Error('Theme installation is busy in another process');
    assertCurrent();
    const current = readInstalledReferences(packages);
    const target = path.join(packages, inspected.packageSha256);
    const names = [...new Set(themes.map(theme => theme.name))];
    const commit = () => {
      const next = new Map(current.map(ref => [ref.id, ref]));
      themes.forEach((theme, i) => next.set(theme.id, {
        id: theme.id, packageSha256: inspected.packageSha256, themePath: inspected.manifest.themes[i],
      }));
      const content = JSON.stringify({ formatVersion: 1, themes: [...next.values()] });
      if (Buffer.byteLength(content) > INDEX_MAX_BYTES) throw new CindyFileError('invalid');
      assertCurrent();
      packageDirectory(root, PACKAGES_DIR);
      // One commit changes both colors and assets for every updated ID. Hashes
      // identify immutable bytes; they do not change a theme's selected identity.
      atomicWriteFileSync(path.join(packages, INSTALL_INDEX), content);
      return names;
    };
    const verifyExisting = async () => {
      const dir = packageDirectory(packages, inspected.packageSha256);
      for (const [relative, bytes] of files) {
        const existing = await readBoundedFileNoFollow(packageFilePath(dir, relative), bytes.length, { containWithin: dir });
        if (!existing?.equals(bytes)) throw new CindyFileError('invalid');
      }
    };
    if (fs.existsSync(target)) {
      await verifyExisting();
      return commit();
    }
    const staging = await fs.promises.mkdtemp(path.join(packages, '.staging-'));
    try {
      for (const [relative, bytes] of files) {
        const destination = path.join(staging, relative);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      }
      assertCurrent();
      packageDirectory(root, PACKAGES_DIR);
      try { fs.renameSync(staging, target); }
      catch (error) {
        if (!fs.existsSync(target)) throw error;
        await verifyExisting();
      }
      return commit();
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  });
}

/** Resolve a selected package resource from current committed references only. */
export async function readThemePackageResource(themesDir: string, id: string, reference: string): Promise<{
  bytes: Buffer; resource: AppearanceResourceDefinition; packageSha256: string; hash: string;
}> {
  const root = fs.realpathSync.native(themesDir);
  const packages = packageDirectory(root, PACKAGES_DIR);
  const ref = readInstalledReferences(packages).find(entry => entry.id === id);
  if (!ref) throw new CindyFileError('invalid');
  const dir = packageDirectory(packages, ref.packageSha256);
  const manifestBytes = readBoundedFileNoFollowSync(packageFilePath(dir, CINDY_PACKAGE_MANIFEST), CINDY_MANIFEST_MAX_BYTES, { containWithin: dir });
  if (!manifestBytes) throw new CindyFileError('invalid');
  const manifest = parseCindyPackageManifest(JSON.parse(manifestBytes.toString('utf8')));
  const resource = manifest.resources?.find(entry => `asset:${entry.id}` === reference);
  if (!resource) throw new CindyFileError('invalid');
  const bytes = await readBoundedFileNoFollow(packageFilePath(dir, resource.path), APPEARANCE_RESOURCE_MAX_BYTES[resource.kind], { containWithin: dir });
  if (!bytes) throw new CindyFileError('invalid');
  const { hash } = inspectAppearanceResource(bytes, resource.kind);
  return { bytes, resource, packageSha256: ref.packageSha256, hash };
}
