import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { libraryNativeReadContext, parseLibraryAssetRef, withLibraryNativeReadContext } from '../library-native-read.js';

const hash = 'a'.repeat(64);
const ref = `library:assets/aa/${hash}/blob.png`;

describe('task library native read context', () => {
  it('maps the latest reference to real file bytes using only the designated granted root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'library-native-read-'));
    try {
      const file = path.join(root, 'assets', 'aa', hash, 'blob.png');
      await mkdir(path.dirname(file), { recursive: true });
      // Synthetic bytes only: this is path wiring evidence, not a vision acceptance.
      await writeFile(file, Buffer.from([137, 80, 78, 71]));
      const context = libraryNativeReadContext(root, ['/user/reference', root], ref);
      const mapping = context.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((value) => value.ref === ref);
      expect(await readFile(mapping.path)).toEqual(Buffer.from([137, 80, 78, 71]));
      expect(context).not.toContain('/user/reference');
      expect(libraryNativeReadContext(root, ['/user/reference'], ref)).not.toContain(root);
      expect(libraryNativeReadContext(null, [root], ref)).not.toContain(root);
      expect(libraryNativeReadContext(undefined, [root], ref)).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    `library:assets/ab/${hash}/blob.png`, `library:assets/aa/${hash}/preview.webp`,
    `library:assets/aa/${hash}/../blob.png`, `cindy-media://blobs/${hash}.png`, '/absolute/blob.png',
  ])('rejects non-canonical blob reference %s', (value) => {
    expect(parseLibraryAssetRef(value)).toBeNull();
  });

  it('preserves image payloads and user content while adding wire-only metadata', () => {
    const content = [{ type: 'image' as const, path: '/attachment.png' }, { type: 'text' as const, text: ref }];
    const result = withLibraryNativeReadContext(content, '/library', ['/library']);
    expect(content).toHaveLength(2);
    expect(result).toHaveLength(3);
    expect((result as unknown[]).slice(0, 2)).toEqual(content);
  });
});
