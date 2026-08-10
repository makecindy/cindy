import { describe, expect, it } from 'vitest';

import { ghostInstallErrorKey } from '../installErrorKey';

describe('ghostInstallErrorKey', () => {
  it('distinguishes a valid plugin that needs a newer Host from an invalid package', () => {
    expect(ghostInstallErrorKey('GHOST_HOST_UNSUPPORTED')).toBe(
      'settings.ghosts.errors.hostUnsupported',
    );
    expect(ghostInstallErrorKey('GHOST_FILE_INVALID')).toBe('settings.ghosts.errors.fileInvalid');
  });
});
