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
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});
