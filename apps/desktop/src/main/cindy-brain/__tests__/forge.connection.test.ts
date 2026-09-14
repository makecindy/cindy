/**
 * FORGE_GUIDE · Cindy Connection 凭证章节存在性。
 * source:'oidc-token' 是插件作者可见的 manifest 契约，手册必须与校验器同步。
 */
import { describe, expect, it } from 'vitest';

import { FORGE_GUIDE } from '../forge.js';

describe('FORGE_GUIDE · Cindy Connection 凭证章节', () => {
  it('说明 oidc-token 的 Host 托管、注入限制和不可读边界', () => {
    for (const marker of [
      '"oidc-token"',
      'Cindy 企业身份断言',
      'Connection JWT',
      'Authorization: Bearer {value}',
      'setup.requires',
      'identities',
      '不允许 `*.example.com` 通配',
      'POST / PUT / PATCH / DELETE',
      '显式调用 `ghost_forge_install` 安装',
      '要求用户手输相同 id',
      '个人身份与手动导入默认不签发',
      '仅 `ghostId` 精确等于 `mivo-canvas` 且精确 oidc-token host 仅为 `mivo-canvas.dsworks.cn` 的组织成员本地安装可解析 audience',
      '市场账本损坏、schema 不认或该 ghostId 记录校验失败时 fail-closed',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});
