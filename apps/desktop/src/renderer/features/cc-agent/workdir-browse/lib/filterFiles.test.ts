import { describe, expect, it } from 'vitest';

import { buildFilterTreeRows, filterFilesWithMeta } from './filterFiles';

describe('filterFilesWithMeta', () => {
  it('only marks results as truncated when there is a match beyond the limit', () => {
    const files = Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`);

    expect(filterFilesWithMeta('file', files)).toEqual({ files, truncated: false });
    expect(filterFilesWithMeta('file', [...files, 'src/file-200.ts'])).toEqual({
      files,
      truncated: true,
    });
  });
});

describe('buildFilterTreeRows', () => {
  it('keeps matching folders and files in tree order', () => {
    expect(
      buildFilterTreeRows([
        'benchmarks/README.md',
        'desktop/frontend/src/components/ReadOnlyBatch.tsx',
        'desktop/README.md',
        'internal/acp/readiness_gate_test.go',
        'internal/agent/read_delivery.go',
      ]),
    ).toEqual([
      { kind: 'directory', relPath: 'benchmarks', label: 'benchmarks', depth: 0 },
      { kind: 'file', relPath: 'benchmarks/README.md', label: 'README.md', depth: 1 },
      { kind: 'directory', relPath: 'desktop', label: 'desktop', depth: 0 },
      {
        kind: 'directory',
        relPath: 'desktop/frontend/src/components',
        label: 'frontend / src / components',
        depth: 1,
      },
      {
        kind: 'file',
        relPath: 'desktop/frontend/src/components/ReadOnlyBatch.tsx',
        label: 'ReadOnlyBatch.tsx',
        depth: 2,
      },
      { kind: 'file', relPath: 'desktop/README.md', label: 'README.md', depth: 1 },
      { kind: 'directory', relPath: 'internal', label: 'internal', depth: 0 },
      { kind: 'directory', relPath: 'internal/acp', label: 'acp', depth: 1 },
      {
        kind: 'file',
        relPath: 'internal/acp/readiness_gate_test.go',
        label: 'readiness_gate_test.go',
        depth: 2,
      },
      { kind: 'directory', relPath: 'internal/agent', label: 'agent', depth: 1 },
      {
        kind: 'file',
        relPath: 'internal/agent/read_delivery.go',
        label: 'read_delivery.go',
        depth: 2,
      },
    ]);
  });

  it('does not lose root files or direct files beside a directory chain', () => {
    expect(buildFilterTreeRows(['README.md', 'src/index.ts', 'src/lib/readme.md'])).toEqual([
      { kind: 'directory', relPath: 'src', label: 'src', depth: 0 },
      { kind: 'directory', relPath: 'src/lib', label: 'lib', depth: 1 },
      { kind: 'file', relPath: 'src/lib/readme.md', label: 'readme.md', depth: 2 },
      { kind: 'file', relPath: 'src/index.ts', label: 'index.ts', depth: 1 },
      { kind: 'file', relPath: 'README.md', label: 'README.md', depth: 0 },
    ]);
  });
});
