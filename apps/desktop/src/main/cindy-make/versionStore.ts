import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import originalFs from 'original-fs';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { createMigrationRuntimeManifest } from '../localDb/migrationRunner.js';
import { CINDY_VERSION_PROTOCOL, type CindyVersionInfo } from '../../shared/cindyVersions.js';
import type { CindyVersionEndpointSnapshot } from './versionRuntimeIdentity.js';

export const VERSION_ID = /^[a-f0-9-]{36}$/;
export const ORIGINAL_DEV_ENV_KEYS = [
  'PATH',
  'XDT_USER_DATA_DIR',
  'XDT_ISOLATED',
  'XDT_ISOLATED_NAME',
  'XDT_USER_DATA_DIR_EPOCH',
  'XDT_DEVICE_ID_OVERRIDE',
  'XDT_SCHEDULER_PASSIVE',
  'XDT_ENDPOINTS_CDN',
  'XDT_ENDPOINT_MANIFEST_FILE',
  'XDT_DEV_SAFE_STORAGE_BASIC',
  'CINDY_AUTH_REGION',
];
export interface VersionProfile {
  userData: string;
  appName: string;
  region: 'cn' | 'global' | 'dev';
  deviceId?: string;
  passive: boolean;
  endpointSnapshot?: CindyVersionEndpointSnapshot;
}
export interface OriginalVersion {
  protocol: 1;
  version?: string;
  commit?: string;
  dirty?: boolean;
  profile: VersionProfile;
  executable: string;
  appPath: string;
  resources: string;
  migrationHash?: string;
  development?: {
    root: string;
    node: string;
    mode: 'local' | 'remote';
    environment: Record<string, string>;
  };
}
export interface PersonalVersion {
  protocol: 1;
  id: string;
  profile: VersionProfile;
  title: string;
  commit: string;
  tree?: string;
  builtAt: string;
  platform: string;
  arch: string;
  executable: string;
  resources: string;
  executableHash: string;
  applicationHash: string;
  migrationHash: string;
}
export function versionError(
  code: 'busy' | 'unavailable' | 'incompatible' | 'launchFailed',
): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
export const versionsRoot = (profile: string) => path.join(profile, 'cindy-versions');
export function versionDirectory(profile: string, id: string): string {
  if (!VERSION_ID.test(id)) throw versionError('unavailable');
  return path.join(versionsRoot(profile), 'versions', id);
}
export function sameVersionPath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}
export function assertVersionDirectory(profile: string, directory: string): void {
  const relative = path.relative(profile, directory);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep))
    throw versionError('unavailable');
  const expected = path.join(fs.realpathSync(profile), relative);
  if (
    fs.lstatSync(directory).isSymbolicLink() ||
    !sameVersionPath(fs.realpathSync(directory), expected)
  )
    throw versionError('unavailable');
}
export function readVersionJson<T>(file: string): T | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
      throw versionError('unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const raw = readAtomicFileSync(file);
  if (raw && raw.length > 256 * 1024) throw versionError('unavailable');
  return raw === null ? null : (JSON.parse(raw) as T);
}
export function writeVersionJson(file: string, value: unknown): void {
  atomicWriteFileSync(file, JSON.stringify(value) + '\n');
}
export function readOriginalVersion(profile: string): OriginalVersion | null {
  const value = readVersionJson<OriginalVersion>(path.join(versionsRoot(profile), 'original.json'));
  if (
    value &&
    (value.protocol !== 1 ||
      !sameVersionPath(value.profile?.userData ?? '', profile) ||
      !path.isAbsolute(value.executable) ||
      !path.isAbsolute(value.resources))
  )
    throw versionError('unavailable');
  if (
    value?.development &&
    (!path.isAbsolute(value.development.root) ||
      typeof value.development.node !== 'string' ||
      !['local', 'remote'].includes(value.development.mode) ||
      !value.development.environment ||
      Object.entries(value.development.environment).some(
        ([key, entry]) => !ORIGINAL_DEV_ENV_KEYS.includes(key) || typeof entry !== 'string',
      ))
  )
    throw versionError('unavailable');
  return value;
}
export function readPersonalVersion(profile: string, id: string): PersonalVersion {
  const directory = versionDirectory(profile, id);
  assertVersionDirectory(profile, directory);
  const item = readVersionJson<PersonalVersion>(path.join(directory, 'version.json'));
  if (
    !item ||
    item.protocol !== 1 ||
    item.id !== id ||
    !sameVersionPath(item.profile?.userData ?? '', profile) ||
    item.platform !== process.platform ||
    item.arch !== process.arch
  )
    throw versionError('unavailable');
  if (
    typeof item.title !== 'string' ||
    item.title.length > 4096 ||
    typeof item.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(item.builtAt)) ||
    typeof item.commit !== 'string' ||
    !/^[0-9a-f]{7,64}$/i.test(item.commit) ||
    (item.tree !== undefined && !/^[0-9a-f]{40,64}$/i.test(item.tree)) ||
    [item.migrationHash, item.executableHash, item.applicationHash].some(
      (hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash),
    )
  )
    throw versionError('unavailable');
  for (const rel of [item.executable, item.resources]) {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\/\\]/).includes('..'))
      throw versionError('unavailable');
    const full = path.join(directory, rel);
    if (!sameVersionPath(fs.realpathSync(full), path.join(fs.realpathSync(directory), rel)))
      throw versionError('unavailable');
  }
  return item;
}
export function migrationIdentity(directory: string): string {
  return createHash('sha256')
    .update(JSON.stringify(createMigrationRuntimeManifest(directory).migrations))
    .digest('hex');
}
export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const data of originalFs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
export function runnableBundlePaths(
  directory: string,
  appName: string,
  platform: NodeJS.Platform = process.platform,
) {
  return {
    executable:
      platform === 'darwin'
        ? path.join(directory, 'Contents', 'MacOS', appName)
        : path.join(directory, appName + (platform === 'win32' ? '.exe' : '')),
    resources:
      platform === 'darwin'
        ? path.join(directory, 'Contents', 'Resources')
        : path.join(directory, 'resources'),
  };
}
async function assertRuntimeLinksInside(directory: string): Promise<void> {
  if ((await originalFs.promises.lstat(directory)).isSymbolicLink())
    throw versionError('unavailable');
  const root = await originalFs.promises.realpath(directory);
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await originalFs.promises.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if (path.isAbsolute(await originalFs.promises.readlink(full)))
          throw versionError('unavailable');
        const target = path.relative(root, await originalFs.promises.realpath(full));
        if (path.isAbsolute(target) || target === '..' || target.startsWith('..' + path.sep))
          throw versionError('unavailable');
      } else if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(directory);
}
export function publishPersonalVersion(profile: string, id: string): void {
  const directory = versionDirectory(profile, id);
  assertVersionDirectory(profile, directory);
  const staged = readVersionJson<PersonalVersion>(path.join(directory, 'staged.json'));
  if (!staged || staged.id !== id) throw versionError('unavailable');
  writeVersionJson(path.join(directory, 'version.json'), staged);
  try {
    fs.unlinkSync(path.join(directory, 'staged.json'));
  } catch {}
}
export async function verifyPersonalVersion(
  profile: string,
  id: string,
  original: OriginalVersion,
): Promise<PersonalVersion> {
  const item = readPersonalVersion(profile, id);
  const root = versionDirectory(profile, id);
  if (
    item.profile.region !== original.profile.region ||
    item.migrationHash !==
      (original.migrationHash ?? migrationIdentity(path.join(original.resources, 'drizzle')))
  )
    throw versionError('incompatible');
  const resources = path.join(root, item.resources);
  if (
    readVersionJson<{ version: number }>(path.join(resources, 'cindy-version-protocol.json'))
      ?.version !== CINDY_VERSION_PROTOCOL ||
    (await fileDigest(path.join(root, item.executable))) !== item.executableHash ||
    (await fileDigest(path.join(resources, 'app.asar'))) !== item.applicationHash ||
    migrationIdentity(path.join(resources, 'drizzle')) !== item.migrationHash
  )
    throw versionError('unavailable');
  return item;
}
export async function withVersionStore<T>(profile: string, run: () => Promise<T>): Promise<T> {
  const root = versionsRoot(profile);
  await fs.promises.mkdir(root, { recursive: true });
  assertVersionDirectory(profile, root);
  return withCrossProcessLock(
    path.join(root, 'registry.lock'),
    { label: 'cindy-versions' },
    async (lock) => {
      if (!lock.held) throw versionError('busy');
      return run();
    },
  );
}
export function selectedVersion(profile: string): string {
  const value = readVersionJson<{ id: string }>(path.join(versionsRoot(profile), 'selected.json'));
  if (!value) return 'original';
  if (value.id !== 'original' && !VERSION_ID.test(value.id)) throw versionError('unavailable');
  return value.id;
}
export async function selectVersion(profile: string, id: string): Promise<void> {
  if (id !== 'original' && !VERSION_ID.test(id)) throw versionError('unavailable');
  await withVersionStore(profile, async () =>
    writeVersionJson(path.join(versionsRoot(profile), 'selected.json'), { id }),
  );
}
export function listPersonalVersions(
  profile: string,
  original: OriginalVersion | null,
): CindyVersionInfo[] {
  const root = path.join(versionsRoot(profile), 'versions');
  if (!fs.existsSync(root)) return [];
  assertVersionDirectory(profile, root);
  let fingerprint: string | undefined;
  try {
    if (original)
      fingerprint =
        original.migrationHash ?? migrationIdentity(path.join(original.resources, 'drizzle'));
  } catch {}
  return fs
    .readdirSync(root)
    .filter((id) => VERSION_ID.test(id))
    .flatMap<CindyVersionInfo>((id) => {
      if (!fs.existsSync(path.join(root, id, 'version.json'))) return [];
      try {
        const item = readPersonalVersion(profile, id);
        return [
          {
            id,
            kind: 'personal' as const,
            title: item.title,
            commit: item.commit,
            builtAt: item.builtAt,
            available: true,
            compatible:
              item.migrationHash === fingerprint &&
              item.profile.region === original?.profile.region,
          },
        ];
      } catch {
        return [{ id, kind: 'personal' as const, available: false, compatible: false }];
      }
    })
    .sort((a, b) => (b.builtAt ?? '').localeCompare(a.builtAt ?? ''));
}

/** Copy the complete signed bundle unchanged; macOS framework symlinks stay inside it. */
export async function retainPersonalVersion(input: {
  profile: VersionProfile;
  sourceDirectory: string;
  appName: string;
  title: string;
  commit: string;
  tree?: string;
}): Promise<string | undefined> {
  const sourceResources = runnableBundlePaths(input.sourceDirectory, input.appName).resources;
  // Old source revisions still export installers, but cannot offer an unsupported profile handoff.
  if (
    readVersionJson<{ version: number }>(path.join(sourceResources, 'cindy-version-protocol.json'))
      ?.version !== 1
  )
    return undefined;
  const sourceInfo = readVersionJson<{ sourceCommit: string; builtAt: string }>(
    path.join(sourceResources, 'cindy-source.json'),
  );
  if (sourceInfo?.sourceCommit !== input.commit || !sourceInfo.builtAt)
    throw versionError('unavailable');
  await assertRuntimeLinksInside(input.sourceDirectory);
  const id = randomUUID();
  const directory = versionDirectory(input.profile.userData, id);
  const runtime = path.join(
    directory,
    'runtime',
    process.platform === 'darwin' ? input.appName + '.app' : input.appName,
  );
  await fs.promises.mkdir(path.dirname(directory), { recursive: true });
  assertVersionDirectory(input.profile.userData, path.dirname(directory));
  try {
    await originalFs.promises.cp(input.sourceDirectory, runtime, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    const { executable, resources } = runnableBundlePaths(runtime, input.appName);
    const item: PersonalVersion = {
      protocol: 1,
      id,
      profile: input.profile,
      title: input.title,
      commit: input.commit,
      ...(input.tree ? { tree: input.tree } : {}),
      builtAt: sourceInfo.builtAt,
      platform: process.platform,
      arch: process.arch,
      executable: path.relative(directory, executable),
      resources: path.relative(directory, resources),
      executableHash: await fileDigest(executable),
      applicationHash: await fileDigest(path.join(resources, 'app.asar')),
      migrationHash: migrationIdentity(path.join(resources, 'drizzle')),
    };
    writeVersionJson(path.join(directory, 'staged.json'), item);
    return id;
  } catch (error) {
    if (fs.existsSync(directory)) {
      assertVersionDirectory(input.profile.userData, directory);
      await originalFs.promises.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
