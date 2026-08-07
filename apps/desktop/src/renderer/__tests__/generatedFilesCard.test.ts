import { describe, expect, it } from 'vitest';

import { isLocalGeneratedFileInTurn } from '../components/chat/GeneratedFilesCard';
import type { GeneratedFileRef } from '../lib/generatedFiles';

const START = Date.parse('2026-08-05T10:00:00.000Z');
const END = Date.parse('2026-08-05T10:01:00.000Z');

const toolFile: GeneratedFileRef = {
  path: 'C:\\work\\report.md',
  name: 'report.md',
  source: 'tool',
};
const commandFile: GeneratedFileRef = { ...toolFile, source: 'command' };

describe('isLocalGeneratedFileInTurn', () => {
  it('accepts a tool-created file whose birthtime falls in the turn', () => {
    expect(
      isLocalGeneratedFileInTurn(
        toolFile,
        { kind: 'file', birthtimeMs: START + 5_000, mtimeMs: START + 5_000 },
        START,
        END,
      ),
    ).toBe(true);
  });

  it('rejects Write against an existing file even when mtime is current', () => {
    expect(
      isLocalGeneratedFileInTurn(
        toolFile,
        { kind: 'file', birthtimeMs: START - 60_000, mtimeMs: START + 5_000 },
        START,
        END,
      ),
    ).toBe(false);
  });

  it('rejects a failed tool path that only appears in a later turn', () => {
    expect(
      isLocalGeneratedFileInTurn(
        toolFile,
        { kind: 'file', birthtimeMs: END + 5_000, mtimeMs: END + 5_000 },
        START,
        END,
      ),
    ).toBe(false);
  });

  it('fails closed for tool entries when birthtime is unavailable', () => {
    expect(
      isLocalGeneratedFileInTurn(
        toolFile,
        { kind: 'file', birthtimeMs: 0, mtimeMs: START + 5_000 },
        START,
        END,
      ),
    ).toBe(false);
  });

  it('keeps the mtime fallback for command candidates on filesystems without birthtime', () => {
    expect(
      isLocalGeneratedFileInTurn(
        commandFile,
        { kind: 'file', birthtimeMs: 0, mtimeMs: START + 5_000 },
        START,
        END,
      ),
    ).toBe(true);
  });
});
