import { describe, expect, it } from 'vitest';

import { extractIpcError } from '../utils/ipcError';

describe('extractIpcError · 主题导入错误码', () => {
  it('识别主题色板无法满足 Switch 对比度的专用错误', () => {
    expect(
      extractIpcError(
        new Error('[THEME_CONTRAST_UNSUPPORTED] unchecked Switch contrast is unsatisfiable'),
      ),
    ).toEqual({
      code: 'THEME_CONTRAST_UNSUPPORTED',
      message: 'unchecked Switch contrast is unsatisfiable',
    });
  });
});
