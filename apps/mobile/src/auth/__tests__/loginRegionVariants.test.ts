import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 国区(cn)/ 国际区(global)两套登录变体的覆盖锁(用户 2026-07-27 追加范围)。
 *
 * mobile 的形态是「一份登录页 + 构建期 region 分支」:AUTH_REGION 来自
 * EXPO_PUBLIC_CINDY_AUTH_REGION(env.ts),一个区出一个包(APP_SCHEME / 端点清单 /
 * Google 配置 / 协议链接分流),**没有**按区分叉的登录页组件、几何表或文案 catalog。
 * 因此本轮改版三件事(面板 440→500、面板内「跳过登录」、无账号进主界面免协议门)
 * 对两区必须同时生效——本测试把这件事钉成回归锁:
 *  ① 用 vi.resetModules + vi.stubEnv **按两种 region 真正重新求值**模块(不是只读
 *     源码字面量),断言几何/文案在两区逐值相同;
 *  ② 断言两区**确实各走各的分支**(协议链接、identifier 形态),证明 region 分支
 *     本身有效、不是「两边都没生效」的假通过;
 *  ③ 源码断言:跳过登录入口挂在两区共用的 identifier 面板里,不在任何 region 分支内。
 * dev 区(本地/自建线)按仓内既有口径归 cn 系,一并覆盖。
 *
 * 限制(如实记录):mobile vitest 是 node 环境、无 RN 渲染能力(仓内既无
 * @testing-library/react-native),两区的**实机 UI 目检**不在本测试覆盖范围。
 */

type Region = 'cn' | 'global' | 'dev';

const loginSource = readFileSync(
  resolve(process.cwd(), 'app/(auth)/login.tsx'),
  'utf8',
);

/** 按指定构建区域重新求值登录链路相关模块(env.ts 在模块求值期读 process.env)。 */
async function loadForRegion(region: Region) {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', region);
  const [env, legalLinks, layout, tokens, messages, identifierMethod] =
    await Promise.all([
      import('@/config/env'),
      import('@/config/legalLinks'),
      import('@/auth/loginSkinLayout'),
      import('@/theme/tokens'),
      import('@/auth/loginMessages'),
      import('@/auth/loginIdentifierMethod'),
    ]);
  return { env, legalLinks, layout, tokens, messages, identifierMethod };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('region 分支本身有效(两区各走各的,不是两边都没生效)', () => {
  it('AUTH_REGION 按构建 env 解析:cn / global / dev', async () => {
    expect((await loadForRegion('cn')).env.AUTH_REGION).toBe('cn');
    expect((await loadForRegion('global')).env.AUTH_REGION).toBe('global');
    expect((await loadForRegion('dev')).env.AUTH_REGION).toBe('dev');
  });

  it('协议链接分流:cn/dev → protocol.xd.cn,global → protocol.xd.com', async () => {
    const cn = await loadForRegion('cn');
    expect(cn.legalLinks.LEGAL_LINKS).toEqual({
      termsOfService: 'https://protocol.xd.cn/cindy/agreement.html',
      privacyPolicy: 'https://protocol.xd.cn/cindy/privacy-1.0.html',
    });
    const global = await loadForRegion('global');
    expect(global.legalLinks.LEGAL_LINKS).toEqual({
      termsOfService: 'https://protocol.xd.com/cindy/agreement-1.0.html',
      privacyPolicy: 'https://protocol.xd.com/cindy/privacy.html',
    });
    // dev 归 cn 系(与 identifier 形态同口径)
    const dev = await loadForRegion('dev');
    expect(dev.legalLinks.LEGAL_LINKS).toEqual(cn.legalLinks.LEGAL_LINKS);
  });

  it('identifier 形态分区互斥:cn/dev → 手机号,global → 邮箱(面板内唯一 region 分叉)', async () => {
    const both = { email: true, phone: true };
    for (const region of ['cn', 'dev'] as const) {
      const m = await loadForRegion(region);
      expect(
        m.identifierMethod.resolveIdentifierMethod(m.env.AUTH_REGION, both),
        region,
      ).toBe('phone');
    }
    const global = await loadForRegion('global');
    expect(
      global.identifierMethod.resolveIdentifierMethod(global.env.AUTH_REGION, both),
    ).toBe('email');
  });
});

describe('改版几何两区同时生效(面板 500 + 「跳过登录」槽 + 组 620)', () => {
  it.each(['cn', 'global', 'dev'] as const)(
    '%s 区:面板 500 / 组 620 / error 槽 50 / 跳过槽 430..490 / 圆钮行 540 / 协议行 642',
    async (region) => {
      const { tokens, layout } = await loadForRegion(region);
      expect(tokens.loginSizes.panelHeight).toBe(500);
      expect(tokens.loginSizes.flowHeight).toBe(620);
      expect(layout.LOGIN_GROUP.height).toBe(620);
      expect(layout.LOGIN_ERROR_TEXT).toEqual({
        y: 380,
        width: 680,
        height: 50,
        font: 20,
      });
      expect(layout.LOGIN_SKIP_LOGIN.y).toBe(430);
      expect(layout.LOGIN_SKIP_LOGIN.height).toBe(60);
      expect(layout.LOGIN_SKIP_LOGIN.width).toBe(680);
      // 文字按钮命中区左右各扩 50 设计px(用户 2026-07-27 拍板),两区同值
      expect(layout.LOGIN_SKIP_LOGIN.pressPadX).toBe(50);
      // 键盘停靠锚 = error 槽底 430(用户 2026-07-27 拍板),两区同值
      expect(layout.LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBe(430);
      expect(layout.LOGIN_SOCIAL.y).toBe(540);
      expect(layout.LOGIN_CONSENT_ROW.y).toBe(642);
      expect(
        layout.LOGIN_CONSENT_ROW.y + layout.LOGIN_CONSENT_ROW.height,
      ).toBe(682);
    },
  );

  it('两档表(立绘/字标/slogan/loginY)在 cn 与 global 下逐值相同(新稿未分区出帧,沿 2026-07-19「双区统一」口径)', async () => {
    const cn = await loadForRegion('cn');
    const global = await loadForRegion('global');
    expect(global.layout.LOGIN_STAGE_SHORT).toEqual(cn.layout.LOGIN_STAGE_SHORT);
    expect(global.layout.LOGIN_STAGE_LONG).toEqual(cn.layout.LOGIN_STAGE_LONG);
    // 顺带钉住新值本身(防「两区一致但都是旧值」的假通过)
    expect(cn.layout.LOGIN_STAGE_SHORT.loginY).toBe(622);
    expect(cn.layout.LOGIN_STAGE_LONG.loginY).toBe(827);
    // 两档外短屏锚常量同样区无关:dh-712 在两区都成立
    expect(global.layout.resolveLoginStage(750, 1000).loginY).toBe(288);
    expect(cn.layout.resolveLoginStage(750, 1000).loginY).toBe(288);
  });
});

describe('「跳过登录」文案与入口两区同时生效', () => {
  it.each(['cn', 'global', 'dev'] as const)(
    '%s 区:skipLogin 4 语文案齐全且一致(catalog 按 locale 而非 region 分支)',
    async (region) => {
      const { messages } = await loadForRegion(region);
      expect(messages.loginMessages['zh-CN'].skipLogin).toBe('跳过登录');
      expect(messages.loginMessages.en.skipLogin).toBe('Skip Sign-In');
      expect(messages.loginMessages.ja.skipLogin).toBe('ログインをスキップ');
      expect(messages.loginMessages.ko.skipLogin).toBe('로그인 건너뛰기');
    },
  );

  it('入口挂在两区共用的 identifier 面板内,且不在任何 region 分支里(源码断言)', () => {
    const panelStart = loginSource.indexOf('<LoginPanel testID="login.panel.identifier">');
    expect(panelStart).toBeGreaterThan(0);
    const panelBlock = loginSource.slice(
      panelStart,
      loginSource.indexOf('</LoginPanel>', panelStart),
    );
    // 面板内确有跳过入口
    expect(panelBlock).toContain('<LoginSkipLoginLink');
    // 面板内唯一的 region 相关分叉是输入框形态(identifierKind),跳过入口不受其影响:
    // 面板段里不出现 AUTH_REGION,且 identifierKind 三元只用于选输入框组件
    expect(panelBlock).not.toContain('AUTH_REGION');
    expect(panelBlock).toContain("identifierKind === 'phone' ? (");
    // 跳过入口的 JSX 与处理函数都不带 region 条件
    const jsxStart = panelBlock.indexOf('<LoginSkipLoginLink');
    const jsxBlock = panelBlock.slice(jsxStart, panelBlock.indexOf('/>', jsxStart));
    expect(jsxBlock).not.toMatch(/AUTH_REGION|identifierKind|region/);
    const handlerStart = loginSource.indexOf('const skipLogin = () => {');
    const handlerBody = loginSource.slice(
      handlerStart,
      loginSource.indexOf('};', handlerStart),
    );
    expect(handlerBody).not.toMatch(/AUTH_REGION|region/);
  });
});

describe('无账号通路(store / 路由门)区无关', () => {
  it('localMode 键与路由门都不按 region 分叉(一区一包,存储天然隔离)', () => {
    const storeSource = readFileSync(
      resolve(process.cwd(), 'src/auth/localModeStore.ts'),
      'utf8',
    );
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const layoutSource = readFileSync(
      resolve(process.cwd(), 'app/_layout.tsx'),
      'utf8',
    );
    const indexSource = readFileSync(
      resolve(process.cwd(), 'app/index.tsx'),
      'utf8',
    );
    expect(storeSource).not.toMatch(/AUTH_REGION|region/);
    expect(layoutSource).toContain('const canEnterApp = auth.isAuthenticated || auth.isLocalMode');
    expect(indexSource).toContain('if (!auth.isAuthenticated && !auth.isLocalMode)');
    // enterLocalMode 全链不读 region
    const start = authSource.indexOf('const enterLocalMode = useCallback');
    const body = authSource.slice(start, authSource.indexOf('const clearLocalSession = useCallback', start));
    expect(body).not.toMatch(/AUTH_REGION|region/);
  });
});
