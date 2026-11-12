import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseCatalog, decideModelRegistrySnapshot } from '@cindy/model-providers';

/** Endpoint-scoped last-known-good catalog, shared by graphical and Node launchers. */
export function createCatalogCache(getUserDataDir: () => string) {
const CATALOG_LKG_VERSION = 2;

interface CatalogLkgEnvelope {
  version: typeof CATALOG_LKG_VERSION;
  scopeHash: string;
  catalog: string;
}

interface CatalogLkgFileIo {
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { force: boolean }): Promise<void>;
}

const catalogLkgWriteTails = new Map<string, Promise<void>>();

function catalogScopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

function catalogLkgPath(scope: string): string {
  return path.join(
    getUserDataDir(),
    'cache',
    'model-catalog',
    `${catalogScopeHash(scope).slice(0, 24)}.json`,
  );
}

function catalogLkgEnvelope(scope: string, catalog: string): CatalogLkgEnvelope {
  return {
    version: CATALOG_LKG_VERSION,
    scopeHash: catalogScopeHash(scope),
    catalog,
  };
}

async function readCatalogLkg(scope: string): Promise<string | null> {
  const file = catalogLkgPath(scope);
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const envelope = JSON.parse(
        await fsp.readFile(candidate, 'utf8'),
      ) as Partial<CatalogLkgEnvelope>;
      return envelope.version === CATALOG_LKG_VERSION &&
        envelope.scopeHash === catalogScopeHash(scope) &&
        typeof envelope.catalog === 'string'
        ? envelope.catalog
        : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

/**
 * Replace an existing LKG without depending on POSIX rename-overwrite semantics. Windows may
 * reject that operation while the destination exists, so preserve the prior snapshot until the
 * new file is in place and restore it if the second rename fails.
 */
async function replaceCatalogLkgFile(
  temporary: string,
  file: string,
  fileIo: CatalogLkgFileIo = fsp,
): Promise<void> {
  try {
    await fileIo.rename(temporary, file);
    await fileIo.rm(`${file}.bak`, { force: true }).catch(() => undefined);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') throw err;
  }

  const backup = `${file}.bak`;
  await fileIo.rm(backup, { force: true }).catch(() => undefined);
  let preservedExisting = false;
  try {
    await fileIo.rename(file, backup);
    preservedExisting = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await fileIo.rename(temporary, file);
  } catch (err) {
    if (preservedExisting) {
      await fileIo.rename(backup, file).catch(() => undefined);
    }
    throw err;
  }
  if (preservedExisting) {
    await fileIo.rm(backup, { force: true }).catch(() => undefined);
  }
}

function catalogLkgTemporaryPath(file: string, nonce = randomUUID()): string {
  return `${file}.${process.pid}.${nonce}.tmp`;
}

/** Serialize the complete replace transaction per scope while leaving different scopes parallel. */
async function serializeCatalogLkgWrite<T>(file: string, write: () => Promise<T>): Promise<T> {
  const previous = catalogLkgWriteTails.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  catalogLkgWriteTails.set(file, tail);
  try {
    return await current;
  } finally {
    if (catalogLkgWriteTails.get(file) === tail) catalogLkgWriteTails.delete(file);
  }
}

function selectCatalogLkgSnapshot(incoming: string, current: string | null): string {
  if (current === null) return incoming;
  try {
    const incomingRegistry = parseCatalog(incoming).modelRegistry;
    const currentRegistry = parseCatalog(current).modelRegistry;
    const decision = decideModelRegistrySnapshot(incomingRegistry, currentRegistry);
    if (decision !== 'accept-incoming') {
      // Registry 缺失、revision 回退或同 revision 异内容都不能覆盖磁盘 LKG；否则
      // 下一次启动已经失去可对照的 last-good，source 层的守卫也无法再救回旧快照。
      return current;
    }
  } catch {
    // An invalid current envelope payload is not an LKG; replace it with the already-validated input.
  }
  return incoming;
}

async function writeCatalogLkg(scope: string, catalog: string): Promise<string> {
  const file = catalogLkgPath(scope);
  return serializeCatalogLkgWrite(file, async () => {
    const selected = selectCatalogLkgSnapshot(catalog, await readCatalogLkg(scope));
    if (selected !== catalog) return selected;
    const temporary = catalogLkgTemporaryPath(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const envelope = catalogLkgEnvelope(scope, selected);
    await fsp.writeFile(temporary, JSON.stringify(envelope), 'utf8');
    try {
      await replaceCatalogLkgFile(temporary, file);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
    return selected;
  });
}

return { catalogLkgEnvelope, catalogLkgPath, catalogLkgTemporaryPath, readCatalogLkg, replaceCatalogLkgFile, selectCatalogLkgSnapshot, serializeCatalogLkgWrite, writeCatalogLkg };
}
