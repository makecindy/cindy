import { describe, expect, it } from 'vitest';

import { parseRemoteMediaUrl } from '../../../../../../shared/remoteMediaUrl';
import { buildFileTreeImagePreviewUrl } from '../fileTreeImagePreview';

describe('buildFileTreeImagePreviewUrl', () => {
  it('uses the guarded local-file protocol for local workdirs', () => {
    const url = buildFileTreeImagePreviewUrl({
      workdir: '/Users/me/project',
      relPath: 'art/cat vs kaiju.svg',
    });

    expect(url).not.toBeNull();
    expect(new URL(url!).searchParams.get('path')).toBe('/Users/me/project/art/cat vs kaiju.svg');
  });

  it('routes SSH workdir images through remote media', () => {
    const url = buildFileTreeImagePreviewUrl({
      workdir: '/home/me/project',
      relPath: 'art/cat.png',
      remoteHostId: 'ssh-host',
    });
    const parsed = parseRemoteMediaUrl(url!);

    expect(parsed?.origin).toEqual({
      kind: 'ssh',
      remoteHostId: 'ssh-host',
      workdir: '/home/me/project',
    });
    expect(new URL(parsed!.origUrl).searchParams.get('path')).toBe('/home/me/project/art/cat.png');
  });

  it('routes device-link images through the owning device', () => {
    const url = buildFileTreeImagePreviewUrl({
      workdir: 'C:\\Users\\me\\project',
      relPath: 'art/cat.png',
      remoteHostId: 'nested-ssh-host',
      deviceId: 'device-A',
    });

    expect(parseRemoteMediaUrl(url!)?.origin).toEqual({
      kind: 'device',
      deviceId: 'device-A',
    });
  });

  it('fails closed when an SSH path cannot be confined to the workdir', () => {
    expect(
      buildFileTreeImagePreviewUrl({
        workdir: '/home/me/project',
        relPath: '../secret.png',
        remoteHostId: 'ssh-host',
      }),
    ).toBeNull();
  });
});
