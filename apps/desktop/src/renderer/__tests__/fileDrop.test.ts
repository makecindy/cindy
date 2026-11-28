import { describe, expect, it } from 'vitest';
import {
  classifyUnclassifiedDroppedItems,
  getDroppedExternalFilePaths,
  getDroppedFileItems,
} from '@/lib/fileDrop';

function transfer(
  items: Array<{
    kind: 'file';
    file: File;
    directory?: boolean;
  }>,
  files: File[] = items.map((item) => item.file),
): DataTransfer {
  return {
    items: items.map((item) => ({
      kind: item.kind,
      getAsFile: () => item.file,
      webkitGetAsEntry: () => ({ isDirectory: item.directory === true }),
    })),
    files,
  } as unknown as DataTransfer;
}

function textTransfer(
  values: Record<string, string>,
  files: File[] = [],
): DataTransfer {
  return {
    files,
    types: Object.keys(values),
    getData: (type: string) => values[type] ?? '',
  } as unknown as DataTransfer;
}

describe('getDroppedFileItems', () => {
  it('keeps the original File objects so native paths survive Windows drops', () => {
    const file = { name: 'report.txt' } as File;

    expect(getDroppedFileItems(transfer([{ kind: 'file', file }]))).toEqual({
      files: [file],
      directories: [],
      unclassified: [],
    });
  });

  it('separates directories without rebuilding the remaining files', () => {
    const file = { name: 'report.txt' } as File;
    const directory = { name: 'project' } as File;

    expect(
      getDroppedFileItems(
        transfer([
          { kind: 'file', file: directory, directory: true },
          { kind: 'file', file },
        ]),
      ),
    ).toEqual({
      files: [file],
      directories: [directory],
      unclassified: [],
    });
  });

  it('preserves item-less Windows drops for native path classification', () => {
    const file = { name: 'report.txt' } as File;

    expect(getDroppedFileItems(transfer([], [file]))).toEqual({
      files: [],
      directories: [],
      unclassified: [file],
    });
  });

  it('classifies item-less directories without replacing the original File objects', async () => {
    const file = { name: 'report.txt' } as File;
    const directory = { name: 'project' } as File;

    await expect(
      classifyUnclassifiedDroppedItems([file, directory], {
        getFilePath: (item) => `C:\\drop\\${item.name}`,
        classifyPath: async (path) => ({
          kind: path.endsWith('\\project') ? 'directory' : 'other',
        }),
      }),
    ).resolves.toEqual({
      files: [file],
      directories: [directory],
    });
  });

  it('keeps item-less files attachable when native path classification fails', async () => {
    const file = { name: 'report.txt' } as File;

    await expect(
      classifyUnclassifiedDroppedItems([file], {
        getFilePath: () => 'C:\\drop\\report.txt',
        classifyPath: async () => {
          throw new Error('stat failed');
        },
      }),
    ).resolves.toEqual({
      files: [file],
      directories: [],
    });
  });
});

describe('getDroppedExternalFilePaths', () => {
  it('reads VS Code ResourceURLs and dedupes the plain-text path', () => {
    expect(
      getDroppedExternalFilePaths(
        textTransfer({
          ResourceURLs: JSON.stringify(['file:///c%3A/Users/me/report.ts']),
          'text/plain': 'C:\\Users\\me\\report.ts\r\n',
        }),
      ),
    ).toEqual(['c:\\Users\\me\\report.ts']);
  });

  it('reads text/uri-list entries and skips comments', () => {
    expect(
      getDroppedExternalFilePaths(
        textTransfer({
          'text/uri-list': '# copied from VS Code\r\nfile:///Users/me/src/a.ts\r\nfile:///Users/me/src/b.ts\r\n',
        }),
      ),
    ).toEqual(['/Users/me/src/a.ts', '/Users/me/src/b.ts']);
  });

  it('reads multiple plain-text paths and ignores relative paths', () => {
    expect(
      getDroppedExternalFilePaths(
        textTransfer({
          'text/plain': 'C:\\work\\a.ts\r\nrelative\\b.ts\r\nD:\\work\\c.ts',
        }),
      ),
    ).toEqual(['C:\\work\\a.ts', 'D:\\work\\c.ts']);
  });

  it('reads VS Code CodeFiles payloads', () => {
    expect(
      getDroppedExternalFilePaths(
        textTransfer({
          CodeFiles: JSON.stringify(['C:\\work\\a.ts', 'https://example.com/b.ts']),
        }),
      ),
    ).toEqual(['C:\\work\\a.ts']);
  });

  it('leaves native file drags to the File-object pipeline', () => {
    const file = { name: 'report.txt' } as File;

    expect(
      getDroppedExternalFilePaths(
        textTransfer({ 'text/plain': 'C:\\work\\report.txt' }, [file]),
      ),
    ).toEqual([]);
  });

  it('does not treat a code selection or link as a file path', () => {
    expect(
      getDroppedExternalFilePaths(
        textTransfer({ 'text/plain': 'const answer = 42;\nhttps://example.com/a.ts' }),
      ),
    ).toEqual([]);
  });
});
