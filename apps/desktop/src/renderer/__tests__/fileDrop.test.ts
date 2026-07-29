import { describe, expect, it } from 'vitest';
import { classifyUnclassifiedDroppedItems, getDroppedFileItems } from '@/lib/fileDrop';

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
