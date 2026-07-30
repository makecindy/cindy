import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { __testing } from '../silkDecoder';

describe('SILK decoder input preparation', () => {
  it('copies Buffer-backed input before it can be transferred', () => {
    const source = Buffer.from([1, 2, 3, 4]);
    const copy = __testing.copySilkBytes(source);

    source[0] = 9;

    expect(copy).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(copy.buffer).not.toBe(source.buffer);
  });
});
