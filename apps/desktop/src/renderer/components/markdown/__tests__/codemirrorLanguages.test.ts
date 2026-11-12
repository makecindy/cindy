import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';

import { getCodeMirrorLanguage } from '../codemirrorLanguages';

describe('getCodeMirrorLanguage — Solidity', () => {
  it('highlights Solidity keywords, strings, and comments', () => {
    // Production entry: getCodeMirrorLanguage. Issue #9479 showed that even a
    // recognized .sol file had no Solidity parser, while a non-null smoke test
    // would not prove useful tokenization. This parser-tier test uses one small
    // contract and asserts the three user-visible token kinds from the report.
    const extension = getCodeMirrorLanguage('solidity');
    expect(extension).not.toBeNull();

    const source = 'contract Counter { string public name = "Cindy"; // note\n}';
    const state = EditorState.create({ doc: source, extensions: [extension!] });
    const highlighted = new Map<string, string>();

    highlightTree(syntaxTree(state), classHighlighter, (from, to, classes) => {
      highlighted.set(source.slice(from, to), classes);
    });

    expect(highlighted.get('contract')).toContain('tok-keyword');
    expect(highlighted.get('"Cindy"')).toContain('tok-string');
    expect(highlighted.get('// note')).toContain('tok-comment');
  });
});
