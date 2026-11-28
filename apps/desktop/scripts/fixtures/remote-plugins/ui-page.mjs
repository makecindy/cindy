export default {
  name: 'remote-plugins',
  entry: './preview.tsx',
  viewport: { width: 1060, height: 850 },
  real: '生产插件目录、安装详情、设备选择器与发布弹窗',
  notCovered: '测试电脑、插件包摘要和权限来自隔离数据，不提交真实市场审核',
  cases: {
    default: { about: '在同一目录中切换两台电脑，打开所选电脑的插件详情和发布预览' },
  },
  async check(page, ui) {
    const openPicker = page.getByRole('button', { name: await ui.t('settings.ghosts.contribution.myPlugins'), exact: true });
    await openPicker.waitFor();
    await ui.capture('catalog');
    await page.getByRole('button', { name: await ui.t('settings.ghosts.remote.device') }).click();
    await page.getByRole('menuitem', { name: '工作电脑' }).click();
    await page.getByRole('button', { name: '个人笔记', exact: true }).click();
    const publish = page.getByRole('button', { name: await ui.t('settings.ghosts.contribution.publishPlugin'), exact: true });
    await publish.waitFor();
    await ui.capture('target-detail');
    await publish.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: await ui.t('settings.ghosts.contribution.submitVersion', { version: '3.0.0' }) }).waitFor();
    await ui.capture('publish-preview');
  },
};
