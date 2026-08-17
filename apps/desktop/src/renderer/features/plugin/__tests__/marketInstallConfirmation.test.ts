import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Clicking install/update must open the catalog permission card immediately.
 * The post-download Host card is only for permissions the preview missed.
 */
describe('market install confirmation', () => {
  const pageSource = readFileSync(
    resolve(__dirname, '../GhostPluginPage.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('shows an immediate catalog permission card before download', () => {
    expect(pageSource).toContain('<GhostUpdateReview');
    expect(pageSource).toContain('<GhostPermissionList');
    expect(pageSource).toContain(
      '下载真实包;权限卡已在页面确认,Host 只在真实包超出已审清单时再弹',
    );
  });
});
