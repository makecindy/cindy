import { describe, expect, it } from 'vitest';

import {
  holdStandaloneStopTokenDelta,
  isPossibleStandaloneStopPrefix,
  stableInternalWebCitationBoundary,
  stableStandaloneModelStopTokenBoundary,
  stripInternalWebCitations,
  stripStandaloneModelStopToken,
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

describe('leaked model stop tokens', () => {
  it('strips a whole-message Grok stop token to empty text', () => {
    expect(stripStandaloneModelStopToken('<|eos|>')).toBe('');
    expect(stripInternalWebCitations('  <|eos|>\n')).toBe('');
  });

  it('leaves embedded stop-token prose intact', () => {
    expect(stripInternalWebCitations('The token is <|eos|>')).toBe('The token is <|eos|>');
    expect(stripInternalWebCitations('done<|eot_id|>')).toBe('done<|eot_id|>');
    expect(stripInternalWebCitations('use <|placeholder|> here')).toBe('use <|placeholder|> here');
  });

  it('holds an incomplete standalone prefix until the closer arrives', () => {
    expect(stableStandaloneModelStopTokenBoundary('hello')).toBe(5);
    expect(stableStandaloneModelStopTokenBoundary('<|eo')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('  <|eo')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('<|eos|>')).toBe(0);
    expect(stableStandaloneModelStopTokenBoundary('The token is <|eo')).toBe('The token is <|eo'.length);
    expect(isPossibleStandaloneStopPrefix('  <|eo')).toBe(true);
    expect(isPossibleStandaloneStopPrefix('<')).toBe(true);
    expect(isPossibleStandaloneStopPrefix('<|')).toBe(true);
    expect(isPossibleStandaloneStopPrefix(`${' '.repeat(23)}<|eos|>`)).toBe(true);
    expect(isPossibleStandaloneStopPrefix('The token is <|eo')).toBe(false);
  });

  it('is idempotent', () => {
    expect(stripInternalWebCitations(stripInternalWebCitations('<|eos|>'))).toBe('');
    expect(stripInternalWebCitations(stripInternalWebCitations('The token is <|eos|>'))).toBe(
      'The token is <|eos|>',
    );
  });

  it('holds a split leftover on one stream without mixing another stream', () => {
    const a = { pending: '', emitted: false };
    const b = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(a, '<|eo')).toBeNull();
    expect(holdStandaloneStopTokenDelta(b, 'answer')).toBe('answer');
    expect(holdStandaloneStopTokenDelta(a, 's|>')).toBeNull();
    expect(a).toEqual({ pending: '<|eos|>', emitted: false });
    expect(b).toEqual({ pending: '', emitted: true });
  });

  it('holds a long-padded leftover token until the closer arrives', () => {
    const buffer = { pending: '', emitted: false };
    const padded = `${' '.repeat(23)}<|eos|>`;
    expect(holdStandaloneStopTokenDelta(buffer, padded)).toBeNull();
    expect(buffer.emitted).toBe(false);
    expect(buffer.pending.endsWith('<|eos|>')).toBe(true);
  });

  it('holds whitespace-only deltas without releasing a later leftover token', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, ' '.repeat(23))).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBeNull();
    expect(buffer.emitted).toBe(false);
    expect(buffer.pending.trim()).toBe('<|eos|>');
  });

  it('holds a one-character leftover prefix until the closer arrives', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '<')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, '|eos|>')).toBeNull();
    expect(buffer).toEqual({ pending: '<|eos|>', emitted: false });
  });

  it('still strips a split web citation after ordinary prose has been emitted', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, '结论。')).toBe('结论。');
    expect(holdStandaloneStopTokenDelta(buffer, '\uE200ci')).toBeNull();
    expect(holdStandaloneStopTokenDelta(buffer, 'te\uE202turn17search1\uE201 后续')).toBe(' 后续');
    expect(buffer.emitted).toBe(true);
    expect(buffer.pending).toBe('');
  });

  it('keeps an embedded stop token after ordinary prose has been emitted', () => {
    const buffer = { pending: '', emitted: false };
    expect(holdStandaloneStopTokenDelta(buffer, 'The token is ')).toBe('The token is ');
    expect(holdStandaloneStopTokenDelta(buffer, '<|eos|>')).toBe('<|eos|>');
  });
});
