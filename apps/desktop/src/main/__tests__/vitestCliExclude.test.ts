import { describe, expect, it } from 'vitest';

import { parseVitestCliExclude } from '../../test/vitest/cliExclude';

describe('parseVitestCliExclude', () => {
  it('collects repeated split and inline exclude options', () => {
    expect(
      parseVitestCliExclude([
        'run',
        '--exclude',
        'src/main/localDb/**',
        '--maxWorkers=8',
        '--exclude=**/*.bench.ts',
      ]),
    ).toEqual(['src/main/localDb/**', '**/*.bench.ts']);
  });

  it('ignores missing and empty exclude values', () => {
    expect(parseVitestCliExclude(['run', '--exclude', '--reporter=dot', '--exclude='])).toEqual(
      [],
    );
  });
});
