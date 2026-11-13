import assert from 'node:assert/strict';

// X 首次关联的告知弹窗只该出现一次; 这里按已确认过处理, 免得它盖住要看的区块。
const storage = { 'xUsageNotice.acknowledgedPrincipals': JSON.stringify(['user-1']) };

export default {
  name: 'official-bot-projects',
  entry: './fixture.tsx',
  viewport: { width: 860, height: 1180 },
  real: 'HookConnectionsSection「项目与模型」区块(所有官方机器人共用), WorkspacePrefsEditor, ModelSelector / PermissionSelector 的 field trigger, 默认项目单选, 各渠道卡',
  notCovered:
    '真实 hook IPC 与服务端镜像、升级时各渠道配置的合并、IM 里 /model 卡回写、添加项目的文件夹选择框; 这些由 main 侧单测覆盖',
  stubs: {
    // 账号登录不在这个设置页场景里; 选择器保持真实。
    'src/renderer/contexts/AuthContext': { partial: `export const useAuth = () => ({ mode: 'local', dataOwnerId: 'fixture-account', user: null });` },
  },
  cases: {
    default: { about: '四个机器人都开着: 区块只出现一次, 默认项目选中某个项目, 部分项目单独配置过', storage, data: { kind: 'all-bots' } },
    'default-chat': { about: '默认项目是「对话」(没设过默认项目)', storage, data: { kind: 'default-chat' } },
    'slack-only': { about: '只开 Slack: 没有默认项目单选(Slack 在每个频道里各自选项目)', storage, data: { kind: 'slack-only' } },
    'no-projects': { about: '侧栏还没有项目: 只有内置「对话」', storage, data: { kind: 'no-projects' } },
    'none-enabled': { about: '一个机器人都没开: 区块不显示', viewport: { width: 860, height: 520 }, storage, data: { kind: 'none-enabled' } },
    'many-projects': { about: '项目很多、名称与路径很长', viewport: { width: 860, height: 2000 }, storage, data: { kind: 'many-projects' } },
    'load-failed': { about: '配置读不出来: 提示 + 重试, 选择器置灰', storage, data: { kind: 'load-failed' } },
    'card-expanded': { about: '展开某个机器人的卡片: 卡片里不再有项目与模型', viewport: { width: 860, height: 1500 }, storage, data: { kind: 'card-expanded' } },
    narrow: { about: '窄窗口(480px): 名称、路径与选择器换行', viewport: { width: 480, height: 1500 }, storage, data: { kind: 'all-bots' } },
    'model-open': { about: '点开某个项目的模型选择', storage, data: { kind: 'all-bots' } },
  },
  async ready(page) {
    await page.locator('#cindy-im-telegram, #cindy-im-slack').first().waitFor();
  },
  async check(page, ui) {
    const blocks = page.locator('#cindy-im-projects-heading');
    if (ui.data.kind === 'none-enabled') {
      assert.equal(await blocks.count(), 0);
      return;
    }
    // 不论开了几个机器人, 区块整页只有一处。
    assert.equal(await blocks.count(), 1);
    const radios = page.getByRole('radio');
    if (ui.data.kind === 'slack-only') assert.equal(await radios.count(), 0);
    if (ui.data.kind === 'all-bots') {
      // 「对话」+ 四个项目; 默认项目只有一个被选中。
      assert.equal(await radios.count(), 5);
      assert.equal(await page.getByRole('radio', { checked: true }).count(), 1);
    }
    if (ui.data.kind === 'no-projects') assert.equal(await radios.count(), 1);
    if (ui.data.kind === 'load-failed') {
      assert.ok(await page.getByRole('button', { name: await ui.t('settings.tina.prefs.retry'), exact: true }).isVisible());
    }
    if (ui.data.kind === 'card-expanded') {
      await page.locator('#cindy-im-telegram-panel').waitFor();
      const panel = page.locator('#cindy-im-telegram-panel');
      assert.equal(await panel.getByRole('radio').count(), 0);
      assert.equal(await blocks.count(), 1);
      // 卡片里留一行指路, 点了回到页面上唯一的那一处。
      assert.ok(await panel.getByText(await ui.t('settings.remoteControl.hook.form.sharedSettingsPointer'), { exact: true }).isVisible());
    }
    if (ui.case === 'model-open') {
      await page.getByRole('button', { name: /orbit-garden/ }).first().click();
      await page.waitForTimeout(300);
      await ui.capture('model-open');
    }
  },
};
