import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { packDirectory, extractDirectoryArchive } from './dir-archive';
import { buildSystemPathBlocklist, isPathAllowedAgainst } from '../filePathPolicy';

export interface ChatFolderUploadArgs {
  deviceId: string;
  sourcePath: string;
  requestId: string;
}

export interface FolderUploadDeps {
  tempRoot(): string;
  op<T>(deviceId: string, args: Record<string, unknown>): Promise<T>;
  assertCurrent(): void;
  stage(params: {
    suggestedName: string;
    expectedSize: bigint;
    copyTo(targetPath: string): Promise<void>;
  }): Promise<string>;
  discard(filePath: string): Promise<void>;
}

/**
 * Prepare an ordinary draft attachment. Upload happens through the existing
 * message attachment pipeline, once the destination task is known.
 */
export async function uploadChatFolder(
  args: ChatFolderUploadArgs,
  deps: FolderUploadDeps,
  progress: (received: number, total: number, phase: 'pack') => void,
  signal: AbortSignal,
): Promise<{ path: string; size: number }> {
  const check = () => {
    signal.throwIfAborted();
    deps.assertCurrent();
  };
  check();
  if (!args?.deviceId || typeof args.sourcePath !== 'string' || !path.isAbsolute(args.sourcePath))
    throw new Error('BAD_ARGS');
  const source = await fs.realpath(args.sourcePath);
  if (
    !isPathAllowedAgainst(source, buildSystemPathBlocklist()) ||
    !(await fs.stat(source)).isDirectory()
  )
    throw new Error('BAD_ARGS');
  const caps = await deps.op<{ folderAttachment?: boolean }>(args.deviceId, {
    workdir: '.',
    op: 'caps',
  });
  if (caps?.folderAttachment !== true) throw new Error('REMOTE_UNSUPPORTED');
  check();
  const temp = await fs.mkdtemp(
    path.join(await fs.realpath(deps.tempRoot()), 'cindy-folder-upload-'),
  );
  let staged: string | undefined;
  try {
    const archive = path.join(temp, 'archive.tar');
    let size = 0,
      skipped = 0;
    progress(0, 0, 'pack');
    await pipeline(
      packDirectory(source, () => skipped++, temp),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          try {
            check();
            size += chunk.length;
            progress(size, 0, 'pack');
            done(null, chunk);
          } catch (error) {
            done(error as Error);
          }
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (skipped) throw new Error('INCOMPLETE_FOLDER');
    check();
    staged = await deps.stage({
      suggestedName: path.basename(source),
      expectedSize: BigInt(size),
      copyTo: (dest) => fs.copyFile(archive, dest),
    });
    check();
    return { path: staged, size };
  } catch (error) {
    if (staged) await deps.discard(staged).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** The extracted tree belongs to the same task attachment as its archive. */
export async function extractChatFolder(archive: string): Promise<string> {
  const destination = `${archive}.contents`;
  await fs.mkdir(destination);
  try {
    if (
      await extractDirectoryArchive(createReadStream(archive), destination, {
        confineSymlinks: true,
      })
    )
      throw new Error('INCOMPLETE_FOLDER');
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
