import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MigrationFile, MigrationFileRef } from '@cindy/device-link';
import { assertDiskCapacity } from './resources';

/** Segments reuse the existing attachment transport and its per-object limits. */
export async function sendParts(
  file: string,
  maxPartBytes: number,
  send: (file: string) => Promise<MigrationFileRef>,
): Promise<MigrationFile> {
  const size = (await fs.stat(file)).size;
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1)
    throw new Error('MIGRATION_NO_SPACE');
  if (size <= maxPartBytes) return send(file);
  const directory = await fs.mkdtemp(path.join(path.dirname(file), 'parts-'));
  const parts: MigrationFileRef[] = [];
  try {
    for (let offset = 0; offset < size; offset += maxPartBytes) {
      const length = Math.min(maxPartBytes, size - offset);
      await assertDiskCapacity([{ path: directory, bytes: length }]);
      const part = path.join(directory, 'part');
      await pipeline(
        createReadStream(file, { start: offset, end: offset + length - 1 }),
        createWriteStream(part, { flags: 'wx', mode: 0o600 }),
      );
      const sent = await send(part);
      if (sent.size !== length) throw new Error('MIGRATION_WORKSPACE_CHANGED');
      parts.push(sent);
      await fs.unlink(part);
    }
    return { size, parts };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function receiveParts(
  file: MigrationFile,
  destination: string,
  receive: (part: MigrationFileRef, destination: string) => Promise<void>,
): Promise<void> {
  if (!('parts' in file)) return receive(file, destination);
  const part = destination + '.part';
  let size = 0;
  try {
    await fs.writeFile(destination, '', { flag: 'wx', mode: 0o600 });
    for (const item of file.parts) {
      await assertDiskCapacity([
        { path: path.dirname(destination), bytes: file.size - size + item.size },
      ]);
      await receive(item, part);
      if ((await fs.stat(part)).size !== item.size) throw new Error('MIGRATION_INVALID_FILE');
      await pipeline(createReadStream(part), createWriteStream(destination, { flags: 'a' }));
      size += item.size;
      await fs.unlink(part);
    }
    if (size !== file.size) throw new Error('MIGRATION_INVALID_FILE');
  } finally {
    await fs.rm(part, { force: true });
  }
}
