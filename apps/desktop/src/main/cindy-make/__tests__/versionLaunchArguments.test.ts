import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { versionEntryArguments } from '../versionLaunchArguments';
describe('version handoff entry arguments', () => {
  it('keeps existing links and file entry points without forwarding debug or profile flags', () => {
    const folder = path.join(os.tmpdir(), 'folder with spaces');
    const file = path.join(os.tmpdir(), 'sample.cindy');
    expect(
      versionEntryArguments([
        '--inspect=1234',
        '--user-data-dir=/other',
        '--require=private',
        'cindy://session/test',
        'xdt-maker://project/example',
        '--open-folder',
        folder,
        file,
      ]),
    ).toEqual([
      'cindy://session/test',
      'xdt-maker://project/example',
      '--open-folder',
      folder,
      file,
    ]);
  });
  it('rejects unrecognized schemes and relative file paths', () => {
    expect(
      versionEntryArguments([
        'https://example.invalid',
        '--open-folder=../private',
        '../file.cindy',
        '--cindy-version-helper=unknown',
      ]),
    ).toEqual([]);
  });
});
