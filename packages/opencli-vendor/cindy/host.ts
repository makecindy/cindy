import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, openSync, closeSync, fstatSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

/** Lazy allocation: importing the catalog never touches the filesystem.
 * The host chooses the parent; mkdtemp creates an unpredictable private directory
 * (0700 on POSIX). This is ordinary trusted-host temporary storage, not process
 * isolation from another program already running with the same OS user rights.
 */
export function recipeTemporaryDirectory(): string {
  const host = activeHost();
  if (host.temporaryDirectory) return host.temporaryDirectory;
  const parent = host.files?.temporaryRoot ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  return host.temporaryDirectory = mkdtempSync(join(parent, 'cindy-recipe-'));
}

export function recipeDiagnosticPath(name: string): string {
  return join(recipeTemporaryDirectory(), basename(name));
}

/** Both backends consume broker-approved bytes from invocation-owned copies. */
export function stageRecipeUploadFiles(files: string[]): string[] {
  if (!files.length || files.length > 20) throw new Error('Upload requires 1 to 20 files');
  let total = 0;
  return files.map((file) => {
    const bytes = readRecipeFileSync(file);
    total += bytes.length;
    if (bytes.length > 100 * 1024 * 1024 || total > 500 * 1024 * 1024)
      throw new Error('Upload byte limit exceeded');
    const dir = mkdtempSync(join(recipeTemporaryDirectory(), 'upload-'));
    const staged = join(dir, basename(file));
    writeFileSync(staged, bytes, { mode: 0o600 });
    return staged;
  });
}

export interface RecipeSecrets {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
}

export interface RecipeFiles {
  read(file: string): Buffer;
  open(file: string): number;
  directory?: string;
  temporaryRoot?: string;
  /** Optional trusted-host capability. Desktop deliberately does not grant
   * path-based task writes; only invocation-owned temporary output is enabled. */
  output?(file: string): string;
}

interface RecipeHost {
  secrets?: RecipeSecrets;
  files?: RecipeFiles;
  temporaryDirectory?: string;
  closed: boolean;
  descriptors: Set<number>;
}
const context = new AsyncLocalStorage<RecipeHost>();
function activeHost(): RecipeHost {
  const host = context.getStore();
  if (!host || host.closed) throw new Error('This recipe requires an active host file broker');
  return host;
}

function isTemporaryFile(host: RecipeHost, file: string): boolean {
  if (!host.temporaryDirectory || !isAbsolute(file)) return false;
  const part = relative(host.temporaryDirectory, resolve(file));
  return !!part && !part.startsWith('..') && !isAbsolute(part);
}

/** Relative adapter paths refer to the invoking task, never Desktop's cwd. */
export function resolveRecipePath(...parts: string[]): string {
  if (parts.some(isAbsolute)) return resolve(...parts);
  const directory = activeHost().files?.directory;
  if (!directory) throw new Error('Recipe files require a local session directory');
  return resolve(directory, ...parts);
}

export function recipeOutputPath(file: string): string;
export function recipeOutputPath(file: number): number;
export function recipeOutputPath(file: string | number): string | number {
  const host = activeHost();
  if (typeof file === 'number') {
    if (!host.descriptors.has(file)) throw new Error('Unbrokered recipe file descriptor');
    return file;
  }
  if (typeof file !== 'string') throw new Error('Recipe output must be a local path');
  if (isTemporaryFile(host, file)) return file;
  if (!host.files?.output) throw new Error('Local recipe file export is unavailable; use the browser result or existing file tools');
  return host.files.output(file);
}

export function openRecipeOutputFileSync(file: string, flags: string | number, mode?: number): number {
  const host = activeHost();
  const descriptor = openSync(recipeOutputPath(file), flags, mode);
  host.descriptors.add(descriptor);
  return descriptor;
}

export function closeRecipeFileSync(descriptor: number): void {
  const host = activeHost();
  if (!host.descriptors.delete(descriptor)) throw new Error('Unbrokered recipe file descriptor');
  closeSync(descriptor);
}

/** Copies must validate the source as well as the destination. */
export function recipeCopySource(file: string): string {
  const host = activeHost();
  if (isTemporaryFile(host, file)) return file;
  return stageRecipeUploadFiles([resolveRecipePath(file)])[0];
}

export function withRecipeHost<T>(
  secrets: RecipeSecrets | undefined,
  run: () => Promise<T>,
  files?: RecipeFiles,
): Promise<T> {
  const host: RecipeHost = { secrets, files, closed: false, descriptors: new Set() };
  return context.run(host, async () => {
    try { return await run(); }
    finally {
      host.closed = true;
      // Adapters normally close their own descriptors; also cover failed writes.
      for (const descriptor of host.descriptors) {
        try { closeSync(descriptor); } catch { /* Already closed by the adapter. */ }
      }
      if (host.temporaryDirectory) rmSync(host.temporaryDirectory, { recursive: true, force: true });
    }
  });
}

/** Adapter bytes are available only through the host's session upload policy. */
export function readRecipeFileSync(file: string): Buffer;
export function readRecipeFileSync(file: string, encoding: BufferEncoding): string;
export function readRecipeFileSync(file: string, encoding?: BufferEncoding): Buffer | string {
  const host = activeHost();
  if (!isTemporaryFile(host, file) && !host.files) throw new Error('This recipe requires the host file broker');
  const bytes = isTemporaryFile(host, file) ? readFileSync(file) : host.files!.read(resolveRecipePath(file));
  return encoding ? bytes.toString(encoding) : bytes;
}

export function openRecipeFileSync(file: string): number {
  const host = activeHost();
  const files = host.files;
  if (!isTemporaryFile(host, file) && !files) throw new Error('This recipe requires the host file broker');
  const descriptor = isTemporaryFile(host, file) ? openSync(file, 'r') : files!.open(resolveRecipePath(file));
  host.descriptors.add(descriptor);
  return descriptor;
}

/** Inspection uses the same approved file descriptor boundary as reading. */
export function statRecipeFileSync(file: string): import('node:fs').Stats {
  const descriptor = openRecipeFileSync(file);
  try { return fstatSync(descriptor); }
  finally { closeRecipeFileSync(descriptor); }
}

export function recipeFileExistsSync(file: string): boolean {
  try { statRecipeFileSync(file); return true; }
  catch { return false; }
}

/** Secrets only come from the host encrypted store. The legacy path argument
 * is accepted for pinned adapter compatibility, but is never read or migrated. */
export function readSecretJSON(key: string, _legacyPath?: string): unknown {
  const host = context.getStore();
  const secrets = host?.closed ? undefined : host?.secrets;
  if (!secrets)
    throw new Error("This recipe requires the host credential store");
  const stored = secrets.read(key);
  return stored === null ? null : JSON.parse(stored);
}

export function writeSecretJSON(key: string, value: unknown): void {
  const host = context.getStore();
  const secrets = host?.closed ? undefined : host?.secrets;
  if (!secrets || !secrets.write(key, JSON.stringify(value))) {
    throw new Error(
      "Could not save recipe credentials in the host encrypted store",
    );
  }
}
