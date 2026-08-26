import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ArtifactPreview,
  getDocumentCoverThemeStyle,
  isConfirmedRemoteGeneratedFile,
  isLocalGeneratedFileInTurn,
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
