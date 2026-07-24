import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loginColors, loginSizes } from '@/theme/tokens';

/**
 * PR4a 白底体系视觉行测试(SC-7 slice pr4a:brand-background / login-panel-border /
 * wordmark asset / slogan style / splash-brand)。
 * 组件树依赖 expo/RN 运行时,node vitest 下沿用仓内既有「读源码接线断言」模式
 * (loginScenarioHarness/startupGateCopy 同款);渐变与几何参数由 token/布局引擎
 * 纯数据断言兜底。
 */
const stageSource = readFileSync(
  resolve(process.cwd(), 'src/components/MobileLoginHandoffStage.tsx'),
  'utf8',
);
const controlsSource = readFileSync(
  resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'),
  'utf8',
);
const centeredSource = readFileSync(
  resolve(process.cwd(), 'src/components/CenteredScreen.tsx'),
  'utf8',
);
const layoutSource = readFileSync(
  resolve(process.cwd(), 'app/_layout.tsx'),
  'utf8',
);

describe('loginSkin 白底体系视觉(源码接线 + token 参数)', () => {
  it('brand-background:stage 消费主题 surface 纯平底,撤 wave4 双红渐变叠层(对齐 PR#104)', () => {
    // 底色 = 主题 surface 纯平底(wave4 改判沿用,不另造字面值),用户 2026-07-22 拍板对齐 PR#104
    expect(stageSource).toContain('backgroundColor: colors.login.bgBase');
    // 红渐变叠层已移除:组件定义 / token 引用 / SVG 渐变坐标系 / 品牌红字面量全部不再出现
    expect(stageSource).not.toContain('LoginBackgroundGradients');
    expect(stageSource).not.toContain('loginGradients');
    expect(stageSource).not.toContain('gradientUnits');
    expect(stageSource).not.toContain('#F70121');
  });

  it('brand-background:闸门屏复用同一 full-viewport 宿主(_layout error 分支 stage 化)', () => {
    expect(layoutSource).toContain('<MobileLoginHandoffStage>');
    expect(layoutSource).toContain('StartupGateBlockedContent');
    // 文案 key 化契约保持(startupGateCopy 闸门同源)
    expect(layoutSource).toContain("loginText('endpointGateTitle')");
    expect(layoutSource).toContain("loginText('retry')");
  });

  it('login-panel-border:面板 1px panelBorder 描边 + panelBg r36(368:1383)', () => {
    expect(controlsSource).toContain('borderColor: colors.login.panelBorder');
    expect(controlsSource).toContain('backgroundColor: colors.login.panelBg');
    expect(controlsSource).toContain('borderRadius: loginSizes.panelRadius');
    expect(loginColors.panelBorder).toBe('#D4D4D4');
    expect(loginColors.panelBg).toBe('#FBFBFB');
    expect(loginSizes.panelRadius).toBe(36);
    // RN 无 inset shadow → borderWidth 1 承载 1px inside 描边
    const panelBlock = controlsSource.slice(
      controlsSource.indexOf('panel: {'),
      controlsSource.indexOf('title: {'),
    );
    expect(panelBlock).toContain('borderWidth: 1');
  });

  it('wordmark:黑红新资产 login-wordmark 接入 stage 且框内 contain 等比适配(368:1381)', () => {
    expect(stageSource).toContain("require('../../assets/login/login-wordmark.png')");
    expect(stageSource).toContain('resizeMode="contain"');
    expect(stageSource).toContain('boxStyle(stage.word)');
    // 禁止非等比拉伸:不得出现 stretch
    expect(stageSource).not.toContain('"stretch"');
  });

  it('slogan:近黑 login-slogan 资产接入 stage 且 contain(368:1394,几何沿旧表)', () => {
    expect(stageSource).toContain("require('../../assets/login/login-slogan.png')");
    expect(stageSource).toContain('boxStyle(stage.slogan)');
    expect(stageSource).toContain("require('../../assets/login/login-hero.png')");
    expect(stageSource).toContain('boxStyle(stage.cindy)');
    // SLOGAN 近黑 ink token 冻结(资产本体为矢量位图,token 供参数锚定)
    expect(loginColors.sloganInk).toBe('#2A2828');
  });

  it('splash-brand:CenteredScreen splash 变体复用品牌宿主,红底体系退役', () => {
    expect(centeredSource).toContain('MobileLoginHandoffStage');
    expect(centeredSource).toContain("testID=\"startup.splash\"");
    // 旧红底铺底不再被渲染层消费
    expect(centeredSource).not.toContain('colors.brandSplashBackground');
    expect(centeredSource).not.toContain('cindy-splash-wordmark-white');
  });
});
