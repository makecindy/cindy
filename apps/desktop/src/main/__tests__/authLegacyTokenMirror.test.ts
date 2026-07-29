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

  it('写侧:镜像写入失败必须如实记录,不静默当成已同步', () => {
    const body = sliceBody(
      'function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {',
      '\n}\n',
    );

    // 密钥链暂时不可用 / 权限 / 磁盘满:v1 已是最新,但只读 legacy 的旧版实例这轮追不上。
    // 忽略返回值会让「镜像已生效」成为无根据的假设。
    expect(body).toContain('if (!writeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken)) {');
    const failureIdx = body.indexOf('if (!writeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY');
    expect(body.indexOf('log.warn(', failureIdx)).toBeGreaterThan(failureIdx);
  });

  it('写侧:镜像期间 v1 被清掉**或已前进** → 都按 CAS 撤回刚写的从属副本', () => {
    const body = sliceBody(
      'function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {',
      '\n}\n',
    );

    // 「检查存在 → 写入」不原子。写完必须核对权威记录仍是本次写入的那一条:
    //  - 被清掉(登出)→ 从属副本不能比权威记录活得更久;
    //  - 已前进到更新的一枚 → 本次镜像那枚此刻已失效,留着正是本 PR 要消灭的
    //    「旧版只读 legacy → 拿到死 token → 被强制重登」(codex #878 P1)。
    expect(body).toContain('if (isPersistedSecretAbsent(AUTH_SESSION_KEY)) {');
    expect(body).toContain('latestSession !== serializeAuthSessionRecord(realm, refreshToken)');
    // 必须 compare-and-delete:内容已变说明又有别人写过,不在本次撤回范围内。
    expect(body).toContain(
      'removeSafeIfUnchanged(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken)',
    );
    expect(body).not.toContain('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);');
    // 撤回必须发生在写入之后,否则守的不是这枚刚镜像的 token。
    expect(body.indexOf('writeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken)')).toBeLessThan(
      body.indexOf('const rollBackMirror = '),
    );
    // 读不出权威记录但文件还在(密钥链抖动)属不确定状态,不得撤回。
    expect(body).toContain('latestSession !== null');
  });

  it('读侧:本轮已被拒过的 token 不再算替换候选(防两个来源来回重试)', () => {
    const refreshSource = readFileSync(
      resolve(process.cwd(), 'src/main/authRefreshFailure.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    // v1 与 legacy 分叉时互为「对方眼里的替换 token」。只排除紧邻的上一枚会让两枚来回
    // 被选中,耗尽 maxReplacementRetries 后以 replacement-retry 收尾 —— runtime 每 60s
    // 重试一枚已知无效的凭证而永不过期,冷启动保留不可用凭证并以未登录启动。
    expect(refreshSource).toContain('const rejectedTokens = new Set<string>();');
    expect(refreshSource).toContain('rejectedTokens.add(requestedToken);');
    // 筛选必须发生在「按优先级折叠成一枚」之前:先折叠后过滤会让首选来源里那枚已拒的
    // token 挤掉次选来源里有效的那枚(codex #878 P1)。
    const helper = refreshSource.slice(
      refreshSource.indexOf('const nextReplacementCandidate = ('),
      refreshSource.indexOf('while (true) {'),
    );
    // 全部来源先经 rejectedTokens 过滤,过滤结果才作为 pick 的候选集传进去。
    expect(helper).toContain(
      'opts.readLatestStoredTokens().filter((token) => !token || !rejectedTokens.has(token))',
    );
    expect(helper).toContain('pickRefreshTokenReplacementCandidate(');
    // 主判定与 recheck 循环两处都必须过这道闸,漏一处就仍会来回重试。
    const guardCalls = refreshSource.match(/nextReplacementCandidate\(requestedToken\)/g) ?? [];
    expect(guardCalls.length).toBe(2);
  });

  it('读侧:交出 v1 与 legacy 两个来源且不在此折叠,v1 排前', () => {
    const body = sliceBody('function readStoredRefreshTokenCandidates(', '\n}\n');

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
    // 关键:这里**不能**先挑一枚。挑选要在 runner 里做,只有它知道哪些 token 本轮已被拒;
    // 在这里折叠会让 v1 那枚已失效的 token 挤掉 legacy 里有效的那枚,连带把有效凭证删掉。
    expect(body).not.toContain('pickRefreshTokenReplacementCandidate');
  });

  it('读侧:replacement-retry 走双来源读取,不再只认 v1', () => {
    const body = sliceBody(
      'const run = await runRefreshWithReplacementRetry(initialRefreshToken, {',
      '});',
    );

    expect(body).toContain('readLatestStoredTokens: () => readStoredRefreshTokenCandidates(');
    // 直接把 readPersistedRefreshToken 当唯一来源用就是本次事故的成因。
    expect(body).not.toContain('readLatestStoredToken: () => readPersistedRefreshToken(');
  });

  it('确定性失效后:v1 与 legacy 都按「本轮被拒过的每一枚」CAS 清理', () => {
    // 只认最初那一枚是错的(greptile #878 P1):本轮一旦从另一个来源追赶过,磁盘上现存的
    // 就是清单里较晚的那一枚,拿最初的 token 做 compare-and-delete 会一律 changed,把已
    // 确认失效的凭证留在盘上,旧版实例继续拿它撞 INVALID_REFRESH_TOKEN 被强制重登。
    const helper = sliceBody('function clearConfirmedDeadRefreshTokens(', '\n}\n');
    // 两个文件都要遍历整份清单,而不是只比一枚。
    expect(helper).toContain('for (const token of deadTokens) {');
    expect(helper.match(/for \(const token of deadTokens\) \{/g)?.length).toBe(2);
    // 断言分段写:prettier 会按行宽把这个调用拆成多行,不能锚在单行字面量上。
    expect(helper).toContain('removeSafeIfUnchanged(');
    expect(helper).toContain('serializeAuthSessionRecord(realm, token)');
    expect(helper).toContain('removeSafeIfUnchanged(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, token)');
    // 命中(deleted / failed)即停,不继续拿别的 token 去撞。
    expect(helper).toContain("if (sessionOutcome !== 'changed') break;");
    expect(helper).toContain("if (legacyOutcome !== 'changed') break;");
    // 仍是 compare-and-delete,不得退回无条件删除。
    expect(helper).not.toContain('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);');
    expect(helper).not.toContain('removeSafe(AUTH_SESSION_KEY);');
    // legacy 只在与安装包区域一致时由本进程解释。
    expect(helper).toContain('if (realm !== AUTH_REGION) return;');
    // 三种结果各自如实记日志,failed 不得报成已清理。
    expect(helper).toContain("case 'deleted':");
    expect(helper).toContain("case 'changed':");
    expect(helper).toContain("case 'failed':");

    // 调用点必须落在冷启动确定性失效的**非 passive** 分支里:passive 不得删整机共享凭证。
    const coldStart = sliceBody(
      "if (action.kind === 'definitive-failure') {",
      "} else if (action.kind === 'replacement-retry') {",
    );
    const passiveIdx = coldStart.indexOf('if (isPassiveSharedUserDataInstance()) {');
    const callIdx = coldStart.indexOf('clearConfirmedDeadRefreshTokens(storedRealm,');
    expect(passiveIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(passiveIdx);
    // 传进去的是 runner 回传的整份清单;清单为空才退回最初那一枚。
    expect(coldStart).toContain(
      'const confirmedDeadTokens = rejectedTokens.length > 0 ? rejectedTokens : [storedToken];',
    );
  });

  it('runner 回传本轮被拒过的全部 token,供调用方做清理比对', () => {
    const refreshSource = readFileSync(
      resolve(process.cwd(), 'src/main/authRefreshFailure.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    // 返回类型里必须有这份清单,且每个 return 分支都带上——漏一个分支就会让调用方在那条
    // 路径上退回「只认最初那一枚」的错误清理。
    expect(refreshSource).toContain('rejectedTokens: readonly string[];');
    const returns = refreshSource.match(/rejectedTokens: \[\.\.\.rejectedTokens\],/g) ?? [];
    expect(returns.length).toBe(3);
  });
});
