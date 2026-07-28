import { describe, expect, it } from 'vitest';
import { getDroppedFileItems } from '@/lib/fileDrop';

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
    });
  });

  it('falls back to the original FileList when Windows exposes no items', () => {
    const file = { name: 'report.txt' } as File;

    expect(getDroppedFileItems(transfer([], [file]))).toEqual({
      files: [file],
      directories: [],
    });
  });
});
