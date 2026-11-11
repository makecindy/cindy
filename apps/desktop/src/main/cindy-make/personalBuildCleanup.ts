import path from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import originalFs from 'original-fs';
import { makeSourceCheckoutPath } from './sourcePaths.js';
import type { ContentGit } from './sourceContent.js';

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const cleanupError = () => Object.assign(new Error('cleanupFailed'), { code: 'cleanupFailed' });

/** Only known generated paths in the managed checkout; never a blanket Git clean/reset. */
export async function createPersonalBuildCleanup(
  userData: string,
  region: string,
  git: ContentGit,
) {
  const source = makeSourceCheckoutPath(userData);
  const canonicalSource = path.join(await realpath(userData), path.relative(userData, source));
  const assertPath = async (file: string) => {
    if (!samePath(await realpath(source), canonicalSource)) throw cleanupError();
    const relative = path.relative(source, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw cleanupError();
    // Check every existing ancestor, including junctions on Windows.
    let current = source;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if (
          (await lstat(current)).isSymbolicLink() ||
          !samePath(
            await realpath(current),
            path.join(canonicalSource, path.relative(source, current)),
          )
        )
          throw cleanupError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  };
  const generated = [
    'apps/desktop/out',
    'apps/desktop/.vite',
    'apps/desktop/resources/cindy-source.json',
    `apps/desktop/release/artifacts/${region}/unversioned/${process.platform}-${process.arch}`,
  ];
  const clean = async () => {
    let failed = false;
    for (const relative of generated) {
      try {
        const file = path.join(source, relative);
        await assertPath(file);
        // Personal source may have changed these paths into tracked content. Preserve it.
        if ((await git(['ls-files', '--', relative], source)).trim()) throw cleanupError();
        await assertPath(file);
        await originalFs.promises.rm(file, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
      } catch {
        failed = true;
      }
    }
    if (failed) throw cleanupError();
  };
  const manifest = path.join(source, 'apps/desktop/package.json');
  let original: string | undefined;
  const captureManifest = async () => {
    await assertPath(manifest);
    original = await readFile(manifest, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  };
  const restoreManifest = async () => {
    if (original === undefined) return;
    await assertPath(manifest);
    const current = await readFile(manifest, 'utf8');
    if (current === original) return;
    const before = JSON.parse(original);
    const after = JSON.parse(current);
    // The packaging script rewrites only version/formatting. Never overwrite other edits.
    after.version = before.version;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw cleanupError();
    await writeFile(manifest, original, 'utf8');
  };
  return { clean, captureManifest, restoreManifest };
}
