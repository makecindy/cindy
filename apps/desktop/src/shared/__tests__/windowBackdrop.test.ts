import { describe, expect, it } from 'vitest';

import {
  createWindowBackdropMaterialArgument,
  readWindowBackdropMaterialFromArgv,
} from '../windowBackdrop';

describe('window backdrop material renderer argument', () => {
  it('round-trips every supported material', () => {
    for (const material of ['acrylic', 'mica', 'tabbed', 'none'] as const) {
      expect(
        readWindowBackdropMaterialFromArgv([
          '--unrelated=value',
          createWindowBackdropMaterialArgument(material),
        ]),
      ).toBe(material);
    }
  });

  it('falls back to none when the argument is absent or invalid', () => {
    expect(readWindowBackdropMaterialFromArgv([])).toBe('none');
    expect(
      readWindowBackdropMaterialFromArgv(['--cindy-window-backdrop-material=glass']),
    ).toBe('none');
  });

  it('prefers the BrowserWindow-injected trailing value', () => {
    expect(
      readWindowBackdropMaterialFromArgv([
        '--cindy-window-backdrop-material=mica',
        '--cindy-window-backdrop-material=acrylic',
      ]),
    ).toBe('acrylic');
  });
});
