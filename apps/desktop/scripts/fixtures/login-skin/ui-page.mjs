/** 悬停、按下(鼠标按住不放)都截图;按下截完再松开,下一步从干净状态开始。 */
async function captureStates(page, ui, name, locator) {
  await locator.hover();
  await ui.capture(`${name}-hover`, { locator });
  await page.mouse.down();
  await ui.capture(`${name}-pressed`, { locator });
  await page.mouse.up();
  await page.mouse.move(0, 0);
}

export default {
  name: 'login-skin',
  entry: './login-skin-fixture.tsx',
  viewport: { width: 400, height: 400 },
  real: 'LoginControls 全部登录组件(面板、标题、输入框、主按钮、第三方圆钮、返回钮、重发链接、方式行、协议行与弹窗、SSO 候选层、加载环)与 login-* 颜色 token',
  notCovered:
    '登录流程、LoginStage 画布缩放与品牌层(立绘 / 字标)、真实社交图标资产、浏览器回调页与 Mobile 登录皮;圆钮内图标为占位字形',
  cases: {
    default: { about: '邮箱登录:已填输入框、主按钮、跳过登录、Apple / Google / SSO 圆钮与协议行' },
    code: { about: '验证码:返回钮、聚焦空输入框、重发链接、禁用主按钮与错误文字', viewport: { width: 400, height: 300 } },
    method: { about: '选择登录方式:返回钮与两条方式行', viewport: { width: 400, height: 300 } },
    'sso-history': { about: 'SSO 最近组织候选层与加载中的主按钮', viewport: { width: 400, height: 300 } },
    loading: { about: '大加载环', viewport: { width: 400, height: 300 } },
    consent: { about: '协议弹窗:不同意(次级钮)与同意(主按钮)', viewport: { width: 760, height: 480 } },
  },
  async check(page, ui) {
    if (ui.case === 'default') {
      await captureStates(page, ui, 'primary', page.getByTestId('fixture-primary'));
      await captureStates(page, ui, 'google', page.getByTestId('fixture-google'));
      await captureStates(page, ui, 'apple', page.getByTestId('fixture-apple'));
      await page.getByTestId('fixture-input').hover();
      await ui.capture('input-hover', { locator: page.getByTestId('fixture-input') });
    }
    if (ui.case === 'code') {
      await page.getByTestId('fixture-input').focus();
      await ui.capture('input-focus', { locator: page.getByTestId('fixture-input') });
      await captureStates(page, ui, 'back', page.getByTestId('login-back-button'));
      await captureStates(page, ui, 'link', page.getByTestId('fixture-link'));
    }
    if (ui.case === 'method') {
      await captureStates(page, ui, 'row', page.getByTestId('fixture-row'));
    }
    if (ui.case === 'consent') {
      await captureStates(page, ui, 'disagree', page.getByTestId('login-consent-disagree'));
      await captureStates(page, ui, 'agree', page.getByTestId('login-consent-agree'));
    }
  },
};
