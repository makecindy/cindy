import { describe, expect, it } from 'vitest';

import {
  stableInternalWebCitationBoundary,
  stripInternalWebCitations,
} from './internalCitation.js';

const source1 = '\uE200cite\uE202turn17search1\uE201';
const source2 = '\uE200cite\uE202turn17search1\uE202turn17search2\uE201';

describe('internal Web citation normalization', () => {
  it('strips single and multiple-source markers without changing punctuation', () => {
    expect(stripInternalWebCitations(`结论。${source1}`)).toBe('结论。');
    expect(stripInternalWebCitations(`A ${source1}；B ${source2}。`)).toBe('A ；B 。');
  });

  it('leaves ordinary cite text and unrelated private-use text untouched', () => {
    expect(stripInternalWebCitations('Please cite the source.')).toBe('Please cite the source.');
    expect(stripInternalWebCitations('ordinary \uE200 text')).toBe('ordinary \uE200 text');
  });

  it('is idempotent and strips unfinished final tails', () => {
    expect(stripInternalWebCitations(`done ${source1}`)).toBe('done ');
    expect(stripInternalWebCitations(stripInternalWebCitations(`done ${source1}`))).toBe('done ');
    expect(stripInternalWebCitations('done \uE200cite\uE202turn17sea')).toBe('done ');
    expect(stripInternalWebCitations('done \uE200ci')).toBe('done ');
  });

  it('holds split streaming prefixes and incomplete markers until they are complete', () => {
    expect(stableInternalWebCitationBoundary('done')).toBe(4);
    expect(stableInternalWebCitationBoundary('done \uE200ci')).toBe(5);
    expect(stableInternalWebCitationBoundary('done \uE200cite\uE202turn17sea')).toBe(5);
    expect(stableInternalWebCitationBoundary(`done ${source2}`)).toBe(`done ${source2}`.length);
  });
});
