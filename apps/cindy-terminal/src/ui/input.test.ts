/** Public terminal text boundary: an untrusted model must not execute OSC or CSI.
 * No previous terminal renderer covers this. Minimal input: OSC 52 clipboard set.
 * Tier: unit, pure transforms; CJK + combining marks retain cursor boundaries. */
import { describe,expect,it } from 'vitest';
import { graphemes,terminalText } from './input.js';

describe('terminal text boundary',()=>{
  it('removes terminal instructions while preserving readable output',()=>{
    expect(terminalText('hello\x1b]52;c;YmFk\x07世界\x1b[2J\nnext')).toBe('hello世界\nnext');
  });
  it('edits composed characters as indivisible graphemes',()=>{
    expect(graphemes('中e\u0301👩‍💻')).toEqual(['中','e\u0301','👩‍💻']);
  });
});
