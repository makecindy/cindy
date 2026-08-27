import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('market install flow', () => {
  const pageSource = readFileSync(
    resolve(__dirname, '../GhostPluginPage.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('starts a compatible install without a capability confirmation card', () => {
    expect(pageSource).not.toContain('<GhostUpdateReview');
    expect(pageSource).not.toContain('<GhostManualSummary');
    expect(pageSource).not.toContain('<GhostPermissionList');
    expect(pageSource).toContain('installMarketPackage');
    expect(pageSource).toContain(
      '目录详情用于发现与能力展示；点击更新后由 Main 下载并校验真实包后直接落位',
    );
  });

  it('refreshes the current market detail after an update instead of closing it', () => {
    expect(pageSource).toContain(
      'await refreshVisibleMarketDetail(marketDetail.pluginId).catch(() => undefined);',
    );
  });
});
