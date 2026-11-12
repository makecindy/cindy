import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ArtifactPreview,
  generatedFileVisibleSignature,
  generatedFilesCheckKey,
  getDocumentCoverThemeStyle,
  isConfirmedRemoteGeneratedFile,
  isGeneratedFileStatable,
  isLocalGeneratedFileInTurn,
  mergeGeneratedFileStatResults,
  planGeneratedFilesVisibility,
  retainVisibleGeneratedFiles,
  reuseGeneratedFilesIfUnchanged,
} from '../components/chat/GeneratedFilesCard';
import type { DocumentArtifactMetadata, GeneratedFileRef } from '../lib/generatedFiles';

const START = Date.parse('2026-08-05T10:00:00.000Z');
const END = Date.parse('2026-08-05T10:01:00.000Z');

const toolFile: GeneratedFileRef = {
  path: 'C:\\work\\report.md',
  name: 'report.md',
  source: 'tool',
};
const commandFile: GeneratedFileRef = { ...toolFile, source: 'command' };
const extraToolFile: GeneratedFileRef = {
  path: 'C:\\work\\notes.ts',
  name: 'notes.ts',
  source: 'tool',
};
const confirmedDocumentFile: GeneratedFileRef = {
  ...toolFile,
  name: 'report.docx',
  artifact: { format: 'docx' },
  artifactConfirmed: true,
};

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

  it('accepts a successfully overwritten document by its current mtime', () => {
    expect(
      isLocalGeneratedFileInTurn(
        confirmedDocumentFile,
        { kind: 'file', birthtimeMs: START - 60_000, mtimeMs: START + 5_000 },
        START,
        END,
      ),
    ).toBe(true);
  });

  it('does not grant the mtime path to unconfirmed replay metadata', () => {
    expect(
      isLocalGeneratedFileInTurn(
        { ...confirmedDocumentFile, artifactConfirmed: undefined },
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

describe('remote generated-file visibility', () => {
  it('shows a card only after remote stat definitively confirms a file', () => {
    expect(isConfirmedRemoteGeneratedFile('file')).toBe(true);
    expect(isConfirmedRemoteGeneratedFile('directory')).toBe(false);
    expect(isConfirmedRemoteGeneratedFile('nonfile')).toBe(false);
    expect(isConfirmedRemoteGeneratedFile('unknown')).toBe(false);
  });
});

describe('generatedFileVisibleSignature', () => {
  it('stays stable when only the object identity changes', () => {
    expect(generatedFileVisibleSignature({ ...toolFile })).toBe(
      generatedFileVisibleSignature(toolFile),
    );
  });

  it('changes when the path, source, or artifact changes', () => {
    const base = generatedFileVisibleSignature(toolFile);
    expect(generatedFileVisibleSignature({ ...toolFile, path: 'C:\\work\\other.md' })).not.toBe(
      base,
    );
    expect(generatedFileVisibleSignature(commandFile)).not.toBe(base);
    expect(generatedFileVisibleSignature(confirmedDocumentFile)).not.toBe(base);
    expect(
      generatedFileVisibleSignature({
        ...confirmedDocumentFile,
        artifact: { format: 'docx', theme: 'dark' },
      }),
    ).not.toBe(generatedFileVisibleSignature(confirmedDocumentFile));
    expect(
      generatedFileVisibleSignature({
        ...toolFile,
        artifact: {
          format: 'xlsx',
          preview: { kind: 'sheet', hasHeader: false, rows: [['a,b', 'c']] },
        },
      }),
    ).not.toBe(
      generatedFileVisibleSignature({
        ...toolFile,
        artifact: {
          format: 'xlsx',
          preview: { kind: 'sheet', hasHeader: false, rows: [['a', 'b,c']] },
        },
      }),
    );
  });
});

describe('generatedFilesCheckKey', () => {
  it('ignores in-flight files until the turn is sealed', () => {
    const readyOnly = generatedFilesCheckKey([toolFile], START, null);
    const withInFlight = generatedFilesCheckKey(
      [toolFile, { ...extraToolFile, ready: false }],
      START,
      null,
    );
    expect(withInFlight).toBe(readyOnly);
    expect(
      generatedFilesCheckKey([toolFile, { ...extraToolFile, ready: false }], START, END),
    ).not.toBe(readyOnly);
  });

  it('changes when a file becomes ready', () => {
    const pending = generatedFilesCheckKey([{ ...toolFile, ready: false }], START, null);
    const ready = generatedFilesCheckKey([toolFile], START, null);
    expect(ready).not.toBe(pending);
  });
});

describe('isGeneratedFileStatable', () => {
  it('waits for in-flight tool results while the turn is open', () => {
    expect(isGeneratedFileStatable({ ...toolFile, ready: false }, null)).toBe(false);
    expect(isGeneratedFileStatable({ ...toolFile, ready: false }, END)).toBe(true);
    expect(isGeneratedFileStatable(toolFile, null)).toBe(true);
  });

  it('treats a sealed latest turn like a closed time window', () => {
    expect(isGeneratedFileStatable({ ...toolFile, ready: false }, null, true)).toBe(true);
    const openKey = generatedFilesCheckKey([toolFile], START, null, false);
    const sealedKey = generatedFilesCheckKey([toolFile], START, null, true);
    expect(sealedKey).not.toBe(openKey);
  });
});

describe('planGeneratedFilesVisibility', () => {
  it('does not stat in-flight files and keeps the first paint empty', () => {
    expect(
      planGeneratedFilesVisibility({
        previousVisible: null,
        candidates: [{ ...toolFile, ready: false }],
        turnEndMs: null,
        envChanged: false,
        turnWindowChanged: false,
      }),
    ).toEqual({ visible: null, toStat: [] });
  });

  it('only stats newly ready files', () => {
    const plan = planGeneratedFilesVisibility({
      previousVisible: [toolFile],
      candidates: [toolFile, extraToolFile],
      turnEndMs: null,
      envChanged: false,
      turnWindowChanged: false,
    });
    expect(plan.visible).toBeDefined();
    expect(plan.toStat).toEqual([extraToolFile]);
  });

  it('restats every statable file when the turn window changes', () => {
    const plan = planGeneratedFilesVisibility({
      previousVisible: [toolFile],
      candidates: [toolFile, extraToolFile],
      turnEndMs: END,
      envChanged: false,
      turnWindowChanged: true,
    });
    expect(plan.toStat).toEqual([toolFile, extraToolFile]);
  });

  it('clears the card and restats when the session origin changes', () => {
    expect(
      planGeneratedFilesVisibility({
        previousVisible: [toolFile],
        candidates: [toolFile],
        turnEndMs: null,
        envChanged: true,
        turnWindowChanged: false,
      }),
    ).toEqual({ visible: null, toStat: [toolFile] });
  });

  it('drops a confirmed chip immediately when it disappears with no replacement', () => {
    expect(
      planGeneratedFilesVisibility({
        previousVisible: [toolFile],
        candidates: [],
        turnEndMs: null,
        envChanged: false,
        turnWindowChanged: false,
      }),
    ).toEqual({ visible: [], toStat: [] });
  });

  it('holds the old chip when candidates churn mid-stream', () => {
    const plan = planGeneratedFilesVisibility({
      previousVisible: [toolFile],
      candidates: [extraToolFile],
      turnEndMs: null,
      envChanged: false,
      turnWindowChanged: false,
    });
    expect(plan.visible).toEqual([toolFile]);
    expect(plan.toStat).toEqual([extraToolFile]);
  });

  it('drops held chips once the turn is sealed', () => {
    const plan = planGeneratedFilesVisibility({
      previousVisible: [toolFile],
      candidates: [extraToolFile],
      turnEndMs: END,
      envChanged: false,
      turnWindowChanged: false,
    });
    expect(plan.visible).toEqual([]);
    expect(plan.toStat).toEqual([extraToolFile]);
  });

  it('restats confirmed files when the remote verdict cache changes', () => {
    const plan = planGeneratedFilesVisibility({
      previousVisible: [toolFile],
      candidates: [toolFile],
      turnEndMs: null,
      envChanged: false,
      turnWindowChanged: false,
      forceRestat: true,
    });
    expect(plan.toStat).toEqual([toolFile]);
  });
});

describe('mergeGeneratedFileStatResults', () => {
  it('keeps previously confirmed files and appends newly confirmed ones', () => {
    expect(
      mergeGeneratedFileStatResults({
        previousVisible: [toolFile],
        candidates: [toolFile, extraToolFile],
        checked: [extraToolFile],
        confirmedPaths: new Set([extraToolFile.path]),
        turnWindowChanged: false,
      }),
    ).toEqual([toolFile, extraToolFile]);
  });

  it('swaps a held chip for the newly confirmed replacement in one update', () => {
    expect(
      mergeGeneratedFileStatResults({
        previousVisible: [toolFile],
        candidates: [extraToolFile],
        checked: [extraToolFile],
        confirmedPaths: new Set([extraToolFile.path]),
        turnWindowChanged: false,
      }),
    ).toEqual([extraToolFile]);
  });

  it('replaces a held chip once the new candidate is confirmed', () => {
    expect(
      mergeGeneratedFileStatResults({
        previousVisible: [toolFile],
        candidates: [extraToolFile],
        checked: [extraToolFile],
        confirmedPaths: new Set([extraToolFile.path]),
        turnWindowChanged: false,
      }),
    ).toEqual([extraToolFile]);
  });

  it('drops previously confirmed files that fail a turn-window restat', () => {
    expect(
      mergeGeneratedFileStatResults({
        previousVisible: [toolFile, extraToolFile],
        candidates: [toolFile, extraToolFile],
        checked: [toolFile, extraToolFile],
        confirmedPaths: new Set([extraToolFile.path]),
        turnWindowChanged: true,
      }),
    ).toEqual([extraToolFile]);
  });
});

describe('retainVisibleGeneratedFiles', () => {
  it('keeps the first paint empty until the existence check finishes', () => {
    expect(retainVisibleGeneratedFiles(null, [toolFile])).toBeNull();
  });

  it('keeps already-confirmed chips when the next list still contains them', () => {
    const previous = [toolFile];
    expect(retainVisibleGeneratedFiles(previous, [{ ...toolFile }, extraToolFile])).toBe(previous);
  });

  it('upgrades a visible chip when its artifact metadata arrives', () => {
    const previous = [toolFile];
    expect(retainVisibleGeneratedFiles(previous, [confirmedDocumentFile, extraToolFile])).toEqual([
      confirmedDocumentFile,
    ]);
  });

  it('holds chips whose paths disappeared until the caller asks to drop them', () => {
    expect(retainVisibleGeneratedFiles([toolFile, extraToolFile], [extraToolFile])).toEqual([
      toolFile,
      extraToolFile,
    ]);
    expect(
      retainVisibleGeneratedFiles([toolFile, extraToolFile], [extraToolFile], {
        dropMissing: true,
      }),
    ).toEqual([extraToolFile]);
  });

  it('returns the previous reference when the visible set is unchanged', () => {
    const previous = [toolFile];
    expect(retainVisibleGeneratedFiles(previous, previous)).toBe(previous);
  });
});

describe('reuseGeneratedFilesIfUnchanged', () => {
  it('returns the previous list when signatures match in order', () => {
    const previous = [toolFile, extraToolFile];
    expect(reuseGeneratedFilesIfUnchanged(previous, [{ ...toolFile }, { ...extraToolFile }])).toBe(
      previous,
    );
  });

  it('returns the next list when a newly confirmed file appears', () => {
    const next = [toolFile, extraToolFile];
    expect(reuseGeneratedFilesIfUnchanged([toolFile], next)).toBe(next);
  });
});

describe('document cover theme tokens', () => {
  it('maps each artifact theme to semantic preview tokens', () => {
    const light = getDocumentCoverThemeStyle('light');
    const dark = getDocumentCoverThemeStyle('dark');
    const navy = getDocumentCoverThemeStyle('navy');
    expect(light['--doc-cover-surface']).not.toBe(dark['--doc-cover-surface']);
    expect(navy['--doc-cover-accent']).not.toBe(light['--doc-cover-accent']);
    expect(light['--doc-cover-tint']).not.toBe(dark['--doc-cover-tint']);
    expect(navy['--doc-cover-tint']).not.toBe(light['--doc-cover-tint']);
    expect(light['--doc-cover-ink']).toContain('var(--text-primary)');
  });

  it('applies artifact themes to PPT and Excel previews', () => {
    const artifacts: DocumentArtifactMetadata[] = [
      {
        format: 'pptx',
        theme: 'dark',
        preview: { kind: 'slide', title: 'Quarterly review' },
      },
      {
        format: 'xlsx',
        theme: 'navy',
        preview: { kind: 'sheet', rows: [['Metric'], ['42']], hasHeader: true },
      },
    ];

    const [slide, sheet] = artifacts.map((artifact) =>
      renderToStaticMarkup(createElement(ArtifactPreview, { artifact, title: 'Document' })),
    );
    expect(slide).toContain('data-document-theme="dark"');
    expect(slide).toContain('--doc-cover-surface:var(--surface)');
    expect(sheet).toContain('data-document-theme="navy"');
    expect(sheet).toContain('--doc-cover-tint:color-mix');
  });
});
