import { describe, expect, it } from 'vitest';
import { fileDirectoryLabel, fileDisplayPath, hasCindyTemplateRule } from '../fileMeta';

/**
 * #10679: public display helpers consumed by the tab, list and open-file header.
 * Existing file tree tests cover hierarchy/selection, not ambiguous labels or provenance.
 * Minimal failures: two src/AGENTS.md files, a Windows logical path and an ordinary namesake.
 * Tier: unit, pure logical-path/provenance data, no filesystem or host-platform assumptions.
 */
describe('file identity presentation', () => {
  it('expands matching parent names until same-basename tabs are distinguishable', () => {
    const paths = ['AGENTS.md', 'apps/one/src/AGENTS.md', 'apps/two/src/AGENTS.md'];
    expect(paths.map(path => fileDirectoryLabel(path, paths))).toEqual(['.', 'one/src', 'two/src']);
    expect(fileDirectoryLabel(paths[1], [paths[0], paths[1]])).toBe('src');
    expect(fileDirectoryLabel('apps/one/src/AGENTS.md')).toBe('apps/one/src');
  });

  it('keeps logical Windows drive and UNC paths distinct on every host', () => {
    const paths = ['C:\\one\\src\\AGENTS.md', 'D:\\one\\src\\AGENTS.md'];
    expect(paths.map(path => fileDirectoryLabel(path, paths))).toEqual(['C:/one/src', 'D:/one/src']);
    expect(fileDisplayPath('C:\\projects\\one', 'docs/AGENTS.md')).toBe('C:\\projects\\one\\docs\\AGENTS.md');
    expect(fileDisplayPath('/local', '\\\\server\\share\\AGENTS.md')).toBe('\\\\server\\share\\AGENTS.md');
  });

  it('shows the opened file location without rebasing absolute or remote paths', () => {
    expect(fileDisplayPath('/remote/project/', 'docs/AGENTS.md')).toBe('/remote/project/docs/AGENTS.md');
    expect(fileDisplayPath('/other', '/external/AGENTS.md')).toBe('/external/AGENTS.md');
    expect(fileDisplayPath('/', 'AGENTS.md')).toBe('/AGENTS.md');
    expect(fileDirectoryLabel('/AGENTS.md')).toBe('/');
  });

  it('identifies only exact template-record entries, never a rule-looking filename or body', () => {
    const record = JSON.stringify({ version: 5, files: { 'AGENTS.md': 'a'.repeat(64) } });
    expect(hasCindyTemplateRule('AGENTS.md', record)).toBe(true);
    expect(hasCindyTemplateRule('CLAUDE.md', record)).toBe(false);
    expect(hasCindyTemplateRule('external/AGENTS.md', record)).toBe(false);
    expect(hasCindyTemplateRule('AGENTS.md', '# Cindy project rules')).toBe(false);
    for (const malformed of [{ version: 5, files: { 'AGENTS.md': true } }, { version: 0, files: { 'AGENTS.md': 'a'.repeat(64) } }, null]) {
      expect(hasCindyTemplateRule('AGENTS.md', JSON.stringify(malformed))).toBe(false);
    }
  });
});
