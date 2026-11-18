import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function entry(file: string) {
  return fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function directoryIdentity(dir: string): Promise<string> {
  const info = await entry(dir);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('DIRECTORY_CHANGED');
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

/** Relative links leaving the tree retain their original referent after relocation. */
function relocatedLink(link: string, relativeFile: string, logicalRoot: string): string {
  if (path.isAbsolute(link)) return link;
  const resolved = path.resolve(logicalRoot, path.dirname(relativeFile), link);
  return inside(logicalRoot, resolved) ? link : resolved;
}

function linkSemantic(root: string, logicalRoot: string, relative: string, raw: string): string {
  const resolved = path.resolve(root, path.dirname(relative), raw);
  const semantic = inside(root, resolved)
    ? path.resolve(logicalRoot, path.relative(root, resolved))
    : resolved;
  return process.platform === 'win32' ? path.toNamespacedPath(semantic).toLowerCase() : semantic;
}

async function openRegular(file: string, realRoot: string) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    const named = await entry(file);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !named?.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      !inside(realRoot, await fs.realpath(file))
    )
      throw new Error('FILE_CHANGED_OR_OUTSIDE_WORKSPACE');
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function fileHash(file: string, realRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const { handle, before } = await openRegular(file, realRoot);
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const bytes of stream) hash.update(bytes);
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('WORKSPACE_CHANGED');
    }
    const current = await entry(file);
    if (!current || current.dev !== before.dev || current.ino !== before.ino)
      throw new Error('WORKSPACE_CHANGED');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/** Hash names, contents, permissions and link semantics without following links. */
export async function inspectTree(
  root: string,
  logicalRoot = root,
  hashContents = true,
  signal?: AbortSignal,
) {
  const realRoot = await fs.realpath(root);
  const hash = createHash('sha256');
  let bytes = 0n;
  let files = 0;
  let links = 0;
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const file = path.join(root, relative);
    const info = await entry(file);
    if (!info) throw new Error('WORKSPACE_CHANGED');
    const mode = Number(info.mode & 0o777n);
    if (info.isSymbolicLink()) {
      const link = linkSemantic(root, logicalRoot, relative, await fs.readlink(file));
      hash.update(JSON.stringify([relative, 'link', link]));
      links += 1;
    } else if (info.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory', mode]));
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (info.isFile() && info.nlink === 1n) {
      hash.update(
        JSON.stringify([
          relative,
          'file',
          mode,
          info.size.toString(),
          hashContents ? await fileHash(file, realRoot) : '',
        ]),
      );
      bytes += info.size;
      files += 1;
    } else {
      throw new Error('UNSUPPORTED_FILE_OR_HARD_LINK');
    }
  };
  await visit('');
  return { digest: hash.digest('hex'), bytes: bytes.toString(), files, links };
}

/** Resume only inside a transaction-owned root. Existing entries must match; never overwrite. */
export async function copyTree(source: string, destination: string, resume = false): Promise<void> {
  const realSource = await fs.realpath(source);
  let realDestination = resume ? await fs.realpath(destination) : '';
  const visit = async (relative: string): Promise<void> => {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    const info = await entry(from);
    if (!info) throw new Error('WORKSPACE_CHANGED');
    const existing = resume ? await entry(to) : null;
    if (info.isSymbolicLink()) {
      if (existing) {
        if (
          !existing.isSymbolicLink() ||
          linkSemantic(destination, source, relative, await fs.readlink(to)) !==
            linkSemantic(source, source, relative, await fs.readlink(from))
        )
          throw new Error('TARGET_CONTENT_CHANGED');
        return;
      }
      let link = relocatedLink(await fs.readlink(from), relative, source);
      // NTFS directory junctions do not need Developer Mode. File symlinks do;
      // insufficient privilege fails before the original directory is moved.
      const directory = await fs.stat(from).then(
        (value) => value.isDirectory(),
        (error: NodeJS.ErrnoException) => {
          // Node does not expose a dangling Windows link's file/directory kind.
          // Guessing would change its semantics or require a different privilege.
          if (process.platform === 'win32') throw error;
          return false;
        },
      );
      if (process.platform === 'win32' && directory) link = path.resolve(path.dirname(from), link);
      await fs.symlink(
        link,
        to,
        process.platform === 'win32' && directory ? 'junction' : directory ? 'dir' : 'file',
      );
    } else if (info.isDirectory()) {
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink())
          throw new Error('TARGET_CONTENT_CHANGED');
      } else await fs.mkdir(to, { mode: 0o700 });
      if (relative === '') realDestination = await fs.realpath(to);
      for (const name of (await fs.readdir(from)).sort()) await visit(path.join(relative, name));
      await fs.chmod(to, Number(info.mode & 0o777n));
      // On APFS setting an older mtime can also change birthtime. Keep the
      // transaction-owned root identity stable across interrupted copies.
      if (!resume || relative !== '')
        await fs.utimes(to, Number(info.atimeMs) / 1000, Number(info.mtimeMs) / 1000);
      if (process.platform !== 'win32') {
        const handle = await fs.open(to, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } else if (info.isFile() && info.nlink === 1n) {
      if (existing) {
        if (
          !existing.isFile() ||
          existing.nlink !== 1n ||
          (await fileHash(from, realSource)) !== (await fileHash(to, realDestination))
        )
          throw new Error('TARGET_CONTENT_CHANGED');
        return;
      }
      // Copy from the verified handle, not a pathname which could have become a
      // symlink since lstat. wx also atomically refuses any destination entry.
      const { handle: input, before } = await openRegular(from, realSource);
      const output = await fs.open(to, 'wx', 0o600).catch(async (error) => {
        await input.close();
        throw error;
      });
      try {
        if (!inside(realDestination, await fs.realpath(to))) throw new Error('TARGET_PATH_CHANGED');
        for await (const bytes of input.createReadStream({ autoClose: false }))
          await output.writeFile(bytes);
        const after = await input.stat({ bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error('WORKSPACE_CHANGED');
        await output.chmod(Number(info.mode & 0o777n));
        await output.utimes(Number(info.atimeMs) / 1000, Number(info.mtimeMs) / 1000);
        await output.sync();
      } finally {
        await input.close();
        await output.close();
      }
    } else {
      throw new Error('UNSUPPORTED_FILE_OR_HARD_LINK');
    }
  };
  await visit('');
}
