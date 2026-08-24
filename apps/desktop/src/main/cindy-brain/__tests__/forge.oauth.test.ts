/**
 * FORGE_GUIDE · OAuth 章节存在性(规则 24 最低闸):手册是意识作者的唯一
 * 教材,oauth 凭证契约(source:'oauth' / oauth 详单 / /oauth 通道 / authAccount)
 * 的关键描述必须在场——校验改了手册没跟上,AI 会按旧规则写出过不了校验的包。
 */
import { describe, expect, it } from 'vitest';

import { FORGE_GUIDE } from '../forge.js';

describe('FORGE_GUIDE · oauth 凭证章节', () => {
  it('§2 清单样例含 oauth 详单字段', () => {
    for (const marker of ['"oauth"', 'authorizeUrl', 'tokenUrl', 'extraAuthorizeParams', 'labelPath']) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });

  it('§4.7 讲清主机托管授权与 /oauth 通道协议', () => {
    for (const marker of [
      '主机托管 OAuth 授权',
      "fetch('/oauth')",
      '/oauth/acct/connect',
      'clientConfigured',
      'authAccount',
      'AUTH_EXPIRED',
      'SERVICE_UNAVAILABLE',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });

  it('/oauth 列入主机保留路径', () => {
    expect(FORGE_GUIDE).toContain('`/secrets`、`/oauth`、`/wake`');
  });

  it('redirectPort 与 tokenBroker 三路资格在场(§2 样例 + §4.7 说明 + 拒装原因)', () => {
    for (const marker of [
      '"redirectPort"',
      '"tokenBroker"',
      'redirectPort 不是 1024–65535 整数',
      'tokenBroker 没同时声明 redirectPort',
      '或与 clientSecret 同时声明',
      '三路资格',
      '静态官方前缀照旧放行',
      '服务端 organization market 包已安装',
      'organizationId 与当前组织一致',
      'release sha256 与批准 receipt 的 packageSha256 相等',
      'installOrigin 为 `agent-forge`',
      '不接受手动装入、个人身份或别的组织前缀',
      '只给 Broker 与 oidc-token,不给宿主原语',
      'packageSha256 来源指纹',
      '总长不得超过 64 字符',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });

  it('brokerBounce / scopeDelimiter 两个授权细节字段在场(§2 样例 + 说明 + 拒装原因)', () => {
    for (const marker of [
      '"brokerBounce"',
      '"scopeDelimiter"',
      // §2 样例:双地址弹跳回调的两个路径字段。
      '"callbackPath"',
      // 拒装原因清单:成套声明与路径形状约束。
      'brokerBounce 没和 tokenBroker +',
      'redirectPort 成套声明或路径不是 / 开头的站内绝对路径',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });

  it('region request + clientIdAlternatives 讲清插件自选 App 与主机白名单', () => {
    for (const marker of [
      'cindy.request',
      '/app-context',
      'clientIdAlternatives',
      "region:'cn'|'global'",
      '主机会做清单白名单复验',
    ]) {
      expect(FORGE_GUIDE).toContain(marker);
    }
  });
});
