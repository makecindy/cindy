import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';
import { list as tarList, type ReadEntry } from 'tar';

/**
 * Containment for dependency installation of content nobody has verified yet
 * (fork collaborators' synced commits, see `remoteContentScriptsUnverified`).
 *
 * `pnpm install --ignore-scripts --ignore-pnpmfile` keeps content-controlled code
 * from running at install time, but pnpm still writes wherever its write roots
 * point, and content controls those: a tracked `node_modules` symlink makes it
 * install through the link (pnpm creates `<write root>/<dependency name>`, so the
 * link location is the write root), and `.npmrc` / `pnpm-workspace.yaml` settings
 * such as `store-dir`, `modules-dir` or `virtualStoreDir` move the write roots
 * outright. Before such an install every pnpm write root must be a real
 * descendant of the worktree:
 *
 * - no symlink anywhere in the content resolves outside the worktree;
 * - no content-controlled setting may move a write root or pick which code runs
 *   the install (path-shaped config keys and version-management switches are
 *   refused; the store then comes from the machine's own trusted user-level
 *   configuration or pnpm's default);
 * - the prospective write roots themselves (`node_modules` and its virtual store
 *   under every package directory) still resolve inside the worktree when they
 *   already exist as links from a previous run;
 * - every dependency name and every setting that generates dependency specs
 *   (`pnpm.overrides` and friends, even honored by a frozen lockfile) keeps
 *   inside the worktree: pnpm joins each installed name under its write roots,
 *   so a traversal name escapes no matter where the write roots point. That
 *   includes the transitive names of the frozen lockfile and of the archives a
 *   `file:` dependency installs from — no manifest check sees into those.
 * - after the install, no link pnpm created may resolve outside the worktree
 *   (`assertPnpmInstallLinksContained`) — the pre-install scan cannot see into
 *   the write roots the install is about to populate.
 *
 * The check runs on the filesystem, not `git ls-files`: Git's captured output is
 * truncated and quoted paths are escaped, and a reused worktree may hold links
 * that are no longer tracked.
 */

const MAX_SCANNED_ENTRIES = 200_000;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_ARCHIVES = 512;
const MAX_ARCHIVE_ENTRIES = 2048;

function refuse(message: string): Error {
  return Object.assign(new Error(message), { code: 'gitFailed' });
}

/** Config keys that move pnpm's writes or select the code that performs them. */
const REFUSED_SETTINGS = new Set([
  'usenodeversion',
  'managepackagemanagerversions',
  'packagemanagerstrict',
  'userconfig',
  'globalconfig',
  'prefix',
  'globalprefix',
  'tmp',
  'temp',
]);

/**
 * Whether a pnpm config key names a location. `store-dir`, `virtual-store-dir`,
 * `modules-dir`, `userConfig` and friends do; `frozen-lockfile`, `node-linker`
 * and `engine-strict` do not and keep working. Single-word location keys are in
 * `REFUSED_SETTINGS` above. Kebab/underscore keys are matched on segment
 * boundaries (`lockfile` is not a `-file` key); camelCase keys on the capital
 * suffix (`storeDir`). pnpm itself only reads the kebab form in `.npmrc` and the
 * camelCase form in `pnpm-workspace.yaml`; the wider net costs a refusal at
 * worst, never an escape.
 */
function refusedSetting(key: string): boolean {
  const name = key.trim();
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (REFUSED_SETTINGS.has(normalized)) return true;
  // `configDependencies` (and any sub-key of it) selects the code that performs
  // the writes: pnpm joins each entry's package name under `node_modules/.pnpm-config`,
  // so a path-like name escapes the worktree no matter where the write roots point.
  // Nothing unverified may configure dependencies at all.
  if (normalized.startsWith('configdependencies')) return true;
  return (
    /(?:^|[-_])(?:dir|path|home|file|config)$/i.test(name) ||
    /[a-z](?:Dir|Path|Home|File|Config)$/.test(name)
  );
}

/**
 * A name (or override key) that could turn into a path outside `node_modules`:
 * `..` segments, absolute/drive paths, `~` and backslashes. Override keys stay
 * patterns (`foo@^1`, `bar>baz`, `*`, the nested `.` selector), so this wider
 * net only refuses names that could never match a package either.
 */
function refusedPathLikeName(name: string): boolean {
  return (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('~') ||
    path.isAbsolute(name) ||
    /^[a-zA-Z]:/.test(name) ||
    /(^|\/)\.\.(\/|$)/.test(name)
  );
}

/**
 * An installed package name. pnpm joins it under `node_modules`, so anything
 * outside `[@scope/]name` (leading dots, extra slashes, drive letters) can
 * escape the write roots no matter where they point.
 */
function refusedDependencyName(name: string): boolean {
  return (
    refusedPathLikeName(name) ||
    !/^(?:@[a-zA-Z0-9~][a-zA-Z0-9\-._~]*\/)?[a-zA-Z0-9_\-][a-zA-Z0-9\-._~]*$/.test(name)
  );
}

/** Workspace globs stay relative and inside the tree: `..`, absolute paths and `~` leave it. */
function refusedWorkspacePattern(value: unknown): boolean {
  return (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\\') ||
    value.startsWith('~') ||
    /(^|\/)\.\.($|\/)/.test(value)
  );
}

async function readConfig(file: string): Promise<string> {
  const text = await readFile(file, 'utf8');
  if (text.length > MAX_CONFIG_BYTES) throw refuse(`pnpm config too large: ${path.basename(file)}`);
  return text;
}

/** The recognized pnpm configuration files: never accepted behind a symlink. */
function isPnpmConfigName(name: string): boolean {
  return (
    name === '.npmrc' ||
    name === 'pnpm-workspace.yaml' ||
    name === 'pnpm-workspace.yml' ||
    name === 'package.json' ||
    /pnpmfile\.(?:c|m)?js$/i.test(name)
  );
}

/**
 * The root configuration pnpm reads before anything else, checked without
 * walking the tree: cache warming (`pnpm fetch`) runs this and skips entirely
 * when the content configures its own code (`configDependencies`) or redirects
 * writes. Installs run the full `assertPnpmInstallContained` walk.
 */
export async function assertPnpmConfigContained(root: string): Promise<void> {
  for (const name of ['.npmrc', 'pnpm-workspace.yaml', 'pnpm-workspace.yml', 'package.json']) {
    const full = path.join(root, name);
    let entry;
    try {
      entry = await lstat(full);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) throw refuse(`pnpm config is a symlink: ${name}`);
    if (!entry.isFile()) continue;
    if (name === '.npmrc') checkIni(full, await readConfig(full));
    else if (name === 'package.json') checkPackageJson(full, root, await readConfig(full));
    else checkWorkspaceYaml(full, root, await readConfig(full));
  }
}

function checkIni(file: string, text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    // npm's INI reads a bare line as a key set to true; treat it the same.
    const separator = line.indexOf('=');
    const key = (separator >= 0 ? line.slice(0, separator) : line).trim();
    if (refusedSetting(key)) throw refuse(`pnpm config redirects writes: ${key}`);
  }
}

function checkSettings(
  where: string,
  settings: Record<string, unknown>,
  file: string,
  base: string,
  opts: SpecOptions = {},
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (refusedSetting(key)) throw refuse(`pnpm config redirects writes: ${key} in ${where}`);
    if (key === 'packages' || key === 'workspaces') {
      const patterns = Array.isArray(value) ? value : [value];
      for (const pattern of patterns)
        if (refusedWorkspacePattern(pattern))
          throw refuse(`pnpm workspace leaves the worktree: ${String(pattern)}`);
    }
    // Settings that generate dependency specs when pnpm resolves: a frozen
    // lockfile honors `overrides` values verbatim, so `link:../private` links
    // the outside directory in even with every direct dependency checked.
    if (key === 'overrides' || key === 'resolutions' || key === 'patchedDependencies')
      checkSpecMap(file, base, `${where}#${key}`, value, 'pattern', 0, opts);
    else if (key === 'catalog' || key === 'catalogs' || key === 'packageExtensions')
      checkSpecMap(file, base, `${where}#${key}`, value, 'name', 0, opts);
  }
}

/** The lockfile fields whose keys pnpm joins into write-root paths. */
const LOCKFILE_DEPENDENCY_FIELDS = new Map<string, 'name' | 'pattern'>([
  ['dependencies', 'name'],
  ['devDependencies', 'name'],
  ['optionalDependencies', 'name'],
  ['peerDependencies', 'name'],
  ['specifiers', 'name'],
  ['overrides', 'pattern'],
  ['resolutions', 'pattern'],
  ['patchedDependencies', 'pattern'],
  ['catalog', 'name'],
  ['catalogs', 'name'],
  ['packageExtensions', 'name'],
]);

/** Lockfile sections keyed by resolved package identifiers. */
const LOCKFILE_ID_SECTIONS = new Set(['packages', 'snapshots']);

/** A package identifier whose `..` segments could name the store directory. */
function refusedLockfileId(id: string): boolean {
  if (!id || id.includes('\0')) return true;
  // `link+` identifiers name a workspace path pnpm symlinks to (checked through
  // the spec); every other identifier materializes a store directory of its own.
  return !id.startsWith('link+') && /(^|[\\/:])\.\.([\\/:]|$)/.test(id);
}

/**
 * The frozen lockfile carries the whole transitive graph pnpm installs: its
 * dependency names — including those of package metadata no manifest check
 * ever saw — are joined under the write roots exactly like manifest names.
 * Values may legitimately resolve against any importer's directory or the
 * store, so a path spec only escapes when it leaves the worktree from all of
 * them; `file:` values name the archives checked next.
 */
function checkLockfile(file: string, base: string, text: string, archives: Set<string>): void {
  let lockfile: unknown;
  try {
    lockfile = yaml.load(text);
  } catch {
    throw refuse(`unparseable ${path.basename(file)}`);
  }
  if (lockfile === null || lockfile === undefined) return;
  if (typeof lockfile !== 'object' || Array.isArray(lockfile))
    throw refuse(`unrecognized ${path.basename(file)}`);
  const root = path.dirname(file);
  const dirs = [root, path.join(base, 'node_modules', '.pnpm')];
  const importers = (lockfile as Record<string, unknown>).importers;
  if (importers && typeof importers === 'object' && !Array.isArray(importers)) {
    for (const name of Object.keys(importers)) {
      if (refusedWorkspacePattern(name))
        throw refuse(`pnpm lockfile importer leaves the worktree: ${name}`);
      dirs.push(path.resolve(root, name));
    }
  }
  checkLockfileNode(file, base, dirs, path.basename(file), lockfile, 0, archives);
}

function checkLockfileNode(
  file: string,
  base: string,
  dirs: string[],
  where: string,
  node: unknown,
  depth: number,
  archives: Set<string>,
): void {
  if (depth > 16) throw refuse(`pnpm lockfile nests too deeply: ${where}`);
  if (Array.isArray(node)) {
    for (const nested of node)
      checkLockfileNode(file, base, dirs, where, nested, depth + 1, archives);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, nested] of Object.entries(node as Record<string, unknown>)) {
    const fields = LOCKFILE_DEPENDENCY_FIELDS.get(key);
    if (fields) {
      if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) continue;
      for (const [name, spec] of Object.entries(nested as Record<string, unknown>)) {
        if (fields === 'name' ? refusedDependencyName(name) : refusedPathLikeName(name))
          throw refuse(`pnpm dependency name leaves the worktree: ${name} in ${where}`);
        if (typeof spec !== 'string') {
          checkSpecMap(file, base, `${where}#${key}#${name}`, spec, fields, depth + 2, {
            archives,
            dirs,
          });
          continue;
        }
        // The spec resolves against the dependent's own directory; it escapes
        // only when no directory pnpm may join it against stays in the tree.
        checkDependencySpec(file, base, name, spec, { archives, dirs });
      }
      continue;
    }
    if (LOCKFILE_ID_SECTIONS.has(key) && typeof nested === 'object' && nested !== null) {
      // Identifiers name the directories the store materializes packages into.
      if (Array.isArray(nested)) throw refuse(`unrecognized ${where}`);
      for (const id of Object.keys(nested as Record<string, unknown>))
        if (refusedLockfileId(id))
          throw refuse(`pnpm package identifier leaves the worktree: ${id}`);
    }
    checkLockfileNode(file, base, dirs, `${where}#${key}`, nested, depth + 1, archives);
  }
}

/**
 * A map whose values pnpm turns into installed dependency specs (or, for
 * `patchedDependencies`, patch paths): values naming paths must resolve inside
 * the worktree, and keys must not traverse out of the write roots. Nested
 * entries (npm-style `"foo": { ".": "1" }` overrides, `catalogs`, package
 * extension fields) recurse under the same rule.
 */
function checkSpecMap(
  file: string,
  base: string,
  where: string,
  value: unknown,
  keys: 'name' | 'pattern',
  depth = 0,
  opts: SpecOptions = {},
): void {
  if (depth > 16) throw refuse(`pnpm dependency config nests too deeply: ${where}`);
  if (typeof value === 'string') return checkDependencySpec(file, base, where, value, opts);
  if (Array.isArray(value)) {
    for (const nested of value) checkSpecMap(file, base, where, nested, keys, depth + 1, opts);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys === 'name' ? refusedDependencyName(key) : refusedPathLikeName(key))
      throw refuse(`pnpm dependency name leaves the worktree: ${key} in ${where}`);
    checkSpecMap(file, base, `${where}#${key}`, nested, keys, depth + 1, opts);
  }
}

/** The path a dependency spec names, or undefined for registry specs. */
function specPathTarget(spec: string): string | undefined {
  const value = spec.trim();
  const linked = /^(?:link|file):/i.exec(value);
  const target = linked ? value.slice(linked[0].length) : value;
  const namedPath =
    !!linked ||
    target.startsWith('./') ||
    target.startsWith('../') ||
    path.isAbsolute(target) ||
    /^[a-zA-Z]:/.test(target) ||
    target.startsWith('~') ||
    target.includes('\\') ||
    /(^|\/)\.\.(\/|$)/.test(target);
  return namedPath ? target : undefined;
}

/**
 * A path dependency (`link:`, `file:`, a relative or absolute path) makes pnpm
 * symlink or copy whatever it names — including outside the worktree, where a
 * collaborator can point at credentials or user data. Unverified content may
 * depend on registry packages or on paths that stay inside the tree only.
 * `file:` targets are collected for the archive check below: pnpm reads the
 * package metadata out of them, never out of a manifest we see.
 */
/** Where a spec may resolve against: lockfile specs vary by the dependent's directory. */
interface SpecOptions {
  archives?: Set<string>;
  dirs?: string[];
}

function checkDependencySpec(
  file: string,
  base: string,
  name: string,
  spec: string,
  opts: SpecOptions = {},
): void {
  const target = specPathTarget(spec);
  if (target === undefined) return;
  const dirs = opts.dirs?.length ? opts.dirs : [path.dirname(file)];
  const inside = dirs
    .map((dir) => path.resolve(dir, target))
    .filter((resolved) => {
      const relative = path.relative(base, resolved);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  if (!inside.length) throw refuse(`pnpm dependency leaves the worktree: ${name}`);
  if (opts.archives && /^file:/i.test(spec.trim()))
    for (const resolved of inside) opts.archives.add(resolved);
}

function checkDependencySpecs(
  file: string,
  base: string,
  manifest: Record<string, unknown>,
  opts: SpecOptions = {},
): void {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const specs = manifest[field];
    if (typeof specs !== 'object' || specs === null || Array.isArray(specs)) continue;
    for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
      // pnpm joins each installed name under its write roots: a traversal name
      // escapes wherever those point (`node_modules/../../..` reaches outside
      // the worktree), so names are checked before any spec.
      if (refusedDependencyName(name))
        throw refuse(`pnpm dependency name leaves the worktree: ${name}`);
      if (typeof spec === 'string') checkDependencySpec(file, base, name, spec, opts);
    }
  }
}

/**
 * The manifest of a package pnpm installs out of an archive: no manifest check
 * sees into `file:` tarballs, yet pnpm joins the names inside under the write
 * roots. Names must be package names, and specs may not name paths at all — a
 * path resolves against the store location pnpm extracts to, not the tree.
 */
function checkArchiveManifest(where: string, text: string): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw refuse(`unparseable ${where}`);
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    throw refuse(`unrecognized ${where}`);
  const record = manifest as Record<string, unknown>;
  const checkMap = (specs: unknown, keys: 'name' | 'pattern', depth = 0): void => {
    if (depth > 16) throw refuse(`archive manifest nests too deeply: ${where}`);
    if (Array.isArray(specs)) {
      for (const nested of specs) checkMap(nested, keys, depth + 1);
      return;
    }
    if (typeof specs !== 'object' || specs === null) return;
    for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
      if (keys === 'name' ? refusedDependencyName(name) : refusedPathLikeName(name))
        throw refuse(`pnpm dependency name leaves the worktree: ${name} in ${where}`);
      if (typeof spec === 'string') {
        if (specPathTarget(spec) !== undefined)
          throw refuse(`pnpm dependency leaves the worktree: ${name} in ${where}`);
      } else checkMap(spec, keys, depth + 1);
    }
  };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    checkMap(record[field], 'name');
  for (const key of ['overrides', 'resolutions'])
    if (key in record) checkMap(record[key], 'pattern');
  const pnpm = record.pnpm;
  if (typeof pnpm === 'object' && pnpm !== null && !Array.isArray(pnpm)) {
    for (const [key, value] of Object.entries(pnpm as Record<string, unknown>)) {
      if (key === 'overrides' || key === 'resolutions' || key === 'patchedDependencies')
        checkMap(value, 'pattern');
      else if (key === 'catalog' || key === 'catalogs' || key === 'packageExtensions')
        checkMap(value, 'name');
    }
  }
}

/** `package.json` out of an archive pnpm installs from, without extracting it. */
async function readArchiveManifest(file: string): Promise<string | undefined> {
  let manifest: string | undefined;
  let entries = 0;
  let overflow = false;
  await tarList({
    file,
    filter: (entryPath: string, entry?: { size?: number }) => {
      if (++entries > MAX_ARCHIVE_ENTRIES) throw refuse('archive holds too many entries');
      if (entryPath !== 'package/package.json') return false;
      if ((entry?.size ?? 0) > MAX_CONFIG_BYTES) throw refuse('archive manifest too large');
      return true;
    },
    onentry: (entry: ReadEntry) => {
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > MAX_CONFIG_BYTES) overflow = true;
        else chunks.push(buffer);
      });
      entry.on('end', () => {
        if (manifest === undefined && !overflow) manifest = Buffer.concat(chunks).toString('utf8');
      });
    },
  });
  if (overflow) throw refuse('archive manifest too large');
  return manifest;
}

function checkWorkspaceYaml(
  file: string,
  base: string,
  text: string,
  opts: SpecOptions = {},
): void {
  let settings: unknown;
  try {
    settings = yaml.load(text);
  } catch {
    // Content pnpm could not parse either; never install content we cannot check.
    throw refuse(`unparseable ${path.basename(file)}`);
  }
  if (settings === null || settings === undefined) return;
  if (typeof settings !== 'object' || Array.isArray(settings))
    throw refuse(`unrecognized ${path.basename(file)}`);
  checkSettings(path.basename(file), settings as Record<string, unknown>, file, base, opts);
}

function checkPackageJson(file: string, base: string, text: string, opts: SpecOptions = {}): void {
  let manifest: unknown;
  try {
    // JSON.parse is exactly what pnpm reads, modulo a byte-order mark.
    manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // A fixture pnpm never reads; it cannot configure anything either.
    return;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return;
  const record = manifest as Record<string, unknown>;
  const pnpm = record.pnpm;
  if (typeof pnpm === 'object' && pnpm !== null && !Array.isArray(pnpm))
    checkSettings(`${path.basename(file)}#pnpm`, pnpm as Record<string, unknown>, file, base, opts);
  checkDependencySpecs(file, base, record, opts);
  // npm-style top-level `overrides` and yarn-style `resolutions` generate
  // dependency specs just like `pnpm.overrides` does.
  for (const key of ['overrides', 'resolutions'])
    if (key in record)
      checkSpecMap(file, base, `${path.basename(file)}#${key}`, record[key], 'pattern', 0, opts);
  if ('workspaces' in record) {
    const value = record.workspaces;
    const patterns =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as { packages?: unknown }).packages ?? []
        : value;
    for (const pattern of Array.isArray(patterns) ? patterns : [patterns])
      if (refusedWorkspacePattern(pattern))
        throw refuse(`npm workspace leaves the worktree: ${String(pattern)}`);
  }
}

async function contained(link: string, resolved: string, root: string, rootReal: string): Promise<void> {
  const within = (target: string, base: string) => {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const canonical = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (!within(canonical(resolved), canonical(root)))
    throw refuse(`symlink leaves the worktree: ${path.relative(root, link)}`);
  // The resolved target may sit under further links; the whole chain must stay in.
  try {
    const chain = await realpath(link);
    if (!within(canonical(chain), canonical(rootReal)))
      throw refuse(`symlink chain leaves the worktree: ${path.relative(root, link)}`);
  } catch (error) {
    // A dangling link is judged by its textual target above (fail closed).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Every prospective write root under `directory` (its `node_modules` and the
 * virtual store pnpm keeps inside) must be a real descendant of the worktree:
 * within it textually, and with every existing part of the path resolving within
 * it, so a leftover link from a previous run cannot point the writes outside.
 */
async function assertWriteRootDescends(root: string, rootReal: string, directory: string): Promise<void> {
  const within = (target: string, base: string) => {
    const relative = path.relative(base, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const canonical = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  for (const name of [
    'node_modules',
    path.join('node_modules', '.pnpm'),
    // The store `installCindyMakeWorktree` pins for unverified content.
    path.join('node_modules', '.cindy-make-store'),
  ]) {
    const target = path.resolve(directory, name);
    if (!within(canonical(target), canonical(root))) throw refuse('write root outside the worktree');
    for (let probe = target; ; ) {
      try {
        const resolved = await realpath(probe);
        if (!within(canonical(resolved), canonical(rootReal)))
          throw refuse(`write root leaves the worktree: ${path.relative(root, target)}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if ((error as { code?: string }).code === 'gitFailed') throw error;
          throw refuse('unreadable write root');
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }
}

/**
 * Refuse installation of unverified content whose pnpm writes could leave the
 * worktree; see the module comment for what is checked and why. An install of
 * content the user has verified does not run this: its `.npmrc` may configure
 * the machine's own store as the user chose.
 */
export async function assertPnpmInstallContained(root: string): Promise<void> {
  const base = path.resolve(root);
  let rootReal = base;
  try {
    rootReal = await realpath(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing to install into
    throw refuse('unreadable worktree');
  }
  const packageDirectories: string[] = [base];
  const archives = new Set<string>();
  let scanned = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw refuse('worktree nests too deeply');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw refuse('unreadable worktree');
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) throw refuse('worktree holds too many entries');
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // A recognized config behind a link is never walked past: pnpm follows
        // the link and reads what this scan would have skipped.
        if (isPnpmConfigName(entry.name))
          throw refuse(`pnpm config is a symlink: ${path.relative(base, full)}`);
        await contained(full, path.resolve(directory, await readlink(full)), base, rootReal);
        continue; // never walk through a link
      }
      if (!entry.isFile()) {
        // `.git` bookkeeping and installed dependencies are the harness's and
        // pnpm's own; the `node_modules` entry itself is checked as a link above.
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
          await walk(full, depth + 1);
        continue;
      }
      if (entry.name === '.npmrc') checkIni(full, await readConfig(full));
      else if (entry.name === 'pnpm-workspace.yaml' || entry.name === 'pnpm-workspace.yml')
        checkWorkspaceYaml(full, base, await readConfig(full), { archives });
      else if (entry.name === 'pnpm-lock.yaml' || entry.name === 'pnpm-lock.yml')
        checkLockfile(full, base, await readConfig(full), archives);
      else if (entry.name === 'package.json') {
        packageDirectories.push(directory);
        checkPackageJson(full, base, await readConfig(full), { archives });
      }
    }
  };
  await walk(base, 0);
  for (const directory of packageDirectories)
    await assertWriteRootDescends(base, rootReal, directory);
  // A `file:` dependency installs as a package out of an archive: the names pnpm
  // joins under the write roots come from the manifest inside it, which no walk
  // of the tree can see. Every referenced archive is checked too.
  let scannedArchives = 0;
  for (const archive of archives) {
    if (++scannedArchives > MAX_ARCHIVES) throw refuse('worktree holds too many archives');
    const entry = await lstat(archive).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw refuse('unreadable archive');
    });
    // A missing archive fails the install on its own; a directory dependency's
    // manifest was already walked above.
    if (!entry || entry.isDirectory()) continue;
    if (entry.isSymbolicLink() || !entry.isFile())
      throw refuse(`unrecognized archive: ${path.relative(base, archive)}`);
    const manifest = await readArchiveManifest(archive).catch((error) => {
      if ((error as { code?: string }).code === 'gitFailed') throw error;
      throw refuse(`unreadable archive: ${path.relative(base, archive)}`);
    });
    if (manifest !== undefined)
      checkArchiveManifest(`${path.relative(base, archive)}#package.json`, manifest);
  }
}

/**
 * After installing unverified content, every link the install created under the
 * write roots must resolve within the worktree: a frozen lockfile carries specs
 * the pre-install manifest checks never saw, and installed package content may
 * ship links of its own. Plain files are skipped — only directories and links
 * can lead a later read outside the tree.
 */
export async function assertPnpmInstallLinksContained(root: string): Promise<void> {
  const base = path.resolve(root);
  let rootReal = base;
  try {
    rootReal = await realpath(base);
  } catch {
    throw refuse('unreadable worktree');
  }
  let scanned = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw refuse('worktree nests too deeply');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw refuse('unreadable worktree');
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (++scanned > MAX_SCANNED_ENTRIES) throw refuse('worktree holds too many entries');
        await contained(full, path.resolve(directory, await readlink(full)), base, rootReal);
        continue; // never walk through a link
      }
      if (!entry.isDirectory() || entry.name === '.git') continue;
      if (++scanned > MAX_SCANNED_ENTRIES) throw refuse('worktree holds too many entries');
      await walk(full, depth + 1);
    }
  };
  await walk(base, 0);
}
