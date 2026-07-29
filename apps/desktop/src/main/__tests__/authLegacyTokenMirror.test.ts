import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * legacy → v1 凭证格式迁移窗口内的双向追赶守卫(authManager 依赖 Electron,node 测试
 * 环境无法直接 import,沿用 authPassiveSharedInstance.test.ts 的源码守卫模式)。
 *
 * 守护的契约:共享 userData 的双开实例可能一个只认 `cindy_auth_session_v1`、另一个只认
 * legacy `cindy_auth_refresh_token`。服务端 refresh token 按 (user, device) 一对一存,
 * 两个实例共用同一 deviceId,任一方续期都会作废对方手上那枚——只认单一凭证文件的一方
 * 永远追不上对方轮换出的新 token,会把本可自愈的竞态判成确定性失效并强制重登。
 *
 * 2026-07-29 事故:packaged 0.1.20(只认 legacy)与含 #748 的 dev(只写 v1)共享 userData
 * 双开。dev 在 07:42 续期并把新 token 写进 v1,packaged 07:46 的 refresh 拿
 * INVALID_REFRESH_TOKEN,两次 replacement recheck 读 legacy 都只读到自己那枚已作废的
 * token,于是弹「登录已过期 · 你的账号已在其他设备或实例上退出登录」。
 *
 * 两个方向都要堵:
 *   - 写侧镜像(新版轮换 → 旧版能追上):v1 写成功后同步回写 legacy;
 *   - 读侧回退(旧版轮换 → 新版能追上):replacement 候选同时看 v1 与 legacy。
 */
describe('legacy → v1 refresh token migration window', () => {
  const authSource = readFileSync(
    resolve(process.cwd(), 'src/main/authManager.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const sliceBody = (startAnchor: string, endAnchor: string): string => {
    const start = authSource.indexOf(startAnchor);
    expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
    const end = authSource.indexOf(endAnchor, start);
    expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(start);
    return authSource.slice(start, end);
  };

  it('写侧:v1 写成功才镜像 legacy(v1 始终是唯一权威)', () => {
    const body = sliceBody(
      'function writePersistedAuthSession(refreshToken: string, realm = activeAuthRealm): boolean {',
      '\n}\n',
    );

    expect(body).toContain(
      'writeSafe(AUTH_SESSION_KEY, serializeAuthSessionRecord(realm, refreshToken))',
    );
    // 镜像必须挂在写入结果之后,不能无条件执行:v1 没写成功就镜像,会让 legacy 比权威
    // 记录更新,下次冷启动迁移反而读回一枚不该生效的 token。
    expect(body).toContain('if (written) mirrorLegacyResourceRefreshToken(refreshToken, realm);');
  });

  it('写侧:legacy 文件不存在时不镜像(不凭空复活已清理的凭证文件)', () => {
    const body = sliceBody(
      'function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {',
      '\n}\n',
    );

    // 文件不在 = 没有旧版实例在消费它(或已被独占启动的新版清掉)。凭空写回去等于把
    // 一份本已清理的凭证复活在盘上,并让 clearAuth / 迁移路径的清理白做。
    expect(body).toContain(
      'if (isPersistedSecretAbsent(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)) return;',
    );
    // 必须用 isPersistedSecretAbsent 而非 existsSync/readSafe 判缺席:后两者会把
    // 「密钥链暂时不可用 / EPERM」误判成「文件不存在」,进而漏掉本该做的镜像。
    expect(body).not.toContain('existsSync');
  });

  it('写侧:只镜像与安装包区域一致的 session(legacy 是裸 token,不带 realm)', () => {
    const body = sliceBody(
      'function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {',
      '\n}\n',
    );

    // legacy 格式没有 realm,旧版一律按自己的构建区解释。把对端区域的 token 写进去,
    // 旧版会拿它请求本区 auth-server —— 比不镜像更糟。
    expect(body).toContain('if (realm !== AUTH_REGION) return;');
    const realmGuardIdx = body.indexOf('if (realm !== AUTH_REGION) return;');
    expect(
      body.indexOf('writeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken)'),
    ).toBeGreaterThan(realmGuardIdx);
  });

  it('写侧:值未变化则不落盘(避免无意义 mtime 变化干扰 CAS 删除的身份校验)', () => {
    const body = sliceBody(
      'function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {',
      '\n}\n',
    );

    expect(body).toContain(
      'if (readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) === refreshToken) return;',
    );
  });

  it('读侧:replacement 候选同时看 v1 与 legacy,v1 优先', () => {
    const body = sliceBody('function readLatestReplacementRefreshToken(', '\n}\n');

    expect(body).toContain('pickRefreshTokenReplacementCandidate(requestedToken, [');
    const v1Idx = body.indexOf('readPersistedRefreshToken(realm)');
    const legacyIdx = body.indexOf('readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)');
    expect(v1Idx).toBeGreaterThan(-1);
    expect(legacyIdx).toBeGreaterThan(-1);
    // v1 带 realm、是本版本权威记录,必须排在 legacy 之前。
    expect(v1Idx).toBeLessThan(legacyIdx);
    // legacy 同样只在与安装包区域一致时可解释。
    expect(body).toContain(
      'realm === AUTH_REGION ? readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) : null',
    );
  });

  it('读侧:replacement-retry 走双来源读取,不再只认 v1', () => {
    const body = sliceBody(
      'const run = await runRefreshWithReplacementRetry(initialRefreshToken, {',
      '});',
    );

    expect(body).toContain('readLatestReplacementRefreshToken(opts.realm, requestedToken)');
    // 直接把 readPersistedRefreshToken 当 readLatestStoredToken 用就是本次事故的成因。
    expect(body).not.toContain('readLatestStoredToken: () => readPersistedRefreshToken(');
  });
});
