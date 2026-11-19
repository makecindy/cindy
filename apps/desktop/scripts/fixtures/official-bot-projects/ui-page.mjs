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
    'model-layout': { about: 'Feedback reproduction: a narrow official-bot model field with multiple rich sources', viewport: { width: 800, height: 760 }, storage, data: { kind: 'no-projects' } },
    'model-layout-narrow': { about: 'The same field picker in a 360px viewport', viewport: { width: 360, height: 840 }, storage, data: { kind: 'no-projects' } },
    'model-layout-config': { about: 'Configuration remains usable beside the readable model list', viewport: { width: 800, height: 760 }, storage, data: { kind: 'no-projects' } },
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
    'plugin-only': { about: '没开官方机器人，只装了声明 imEntrance 的 IM 插件：插件卡片与「项目与模型」都显示', viewport: { width: 860, height: 1300 }, storage, data: { kind: 'plugin-only' } },
  },
  async ready(page) {
    await page.locator('#cindy-im-telegram, #cindy-im-slack').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('model-layout')) {
      const heading = page.locator('#cindy-im-projects-heading');
      await heading.evaluate(element => element.scrollIntoView({ block: 'start' }));
      const trigger = page.getByRole('button', { name: /DeepSeek/ }).first();
      const triggerWidth = (await trigger.boundingBox()).width;
      await trigger.click();
      await page.getByRole('listbox').waitFor();
      await page.mouse.move(0, 0);
      await ui.capture('model-list');
      const geometry = await page.locator('[data-unified-model-panel]').evaluate(panel => {
        const list = panel.querySelector('[role="listbox"]');
        const bounds = panel.getBoundingClientRect();
        const names = Array.from(panel.querySelectorAll('[data-unified-anchor] [title="DeepSeek V4.1 Flash"]'));
        const longName = panel.querySelector('[data-unified-anchor] [title="GPT-6.2 Astra Extended Context"]');
        return {
          width: bounds.width,
          longNameReadable: longName && longName.scrollWidth <= longName.clientWidth + 1,
          longNameWraps: longName && longName.clientHeight > parseFloat(getComputedStyle(longName).lineHeight),
          insideViewport: bounds.left >= 11 && bounds.right <= innerWidth - 11,
          available: innerWidth - 24,
          listOverflow: list.scrollWidth > list.clientWidth + 1,
          namesReadable: names.length > 0 && names.every(name => name.clientWidth > 80 && name.scrollWidth <= name.clientWidth + 1),
        };
      });
      assert.ok(
        geometry.width >= Math.min(Math.max(440, triggerWidth), geometry.available) - 3,
        'Rich model picker collapsed to its narrow field',
      );
      assert.ok(geometry.insideViewport, 'Model picker extends beyond the viewport');
      assert.equal(geometry.listOverflow, false, 'Model list requires horizontal scrolling');
      assert.ok(geometry.namesReadable, 'Model names collapsed behind controls');
      assert.ok(geometry.longNameReadable, 'Long model name is clipped');
      if (ui.case === 'model-layout-narrow') {
        assert.ok(geometry.longNameWraps, 'Long model name must wrap in the narrow view');
      }
      if (ui.case !== 'model-layout') {
        await page.locator('[data-row-customize]').first().click();
        const config = page.getByTestId('unified-model-config-flyout');
        await config.waitFor();
        assert.ok(await config.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= -1 && bounds.right <= innerWidth + 1 &&
            bounds.top >= -1 && bounds.bottom <= innerHeight + 1;
        }), 'Model configuration extends beyond the viewport');
        await ui.capture('model-config');
        await page.keyboard.press('Escape');
        await config.waitFor({ state: 'hidden' });
        await page.getByRole('listbox').waitFor();
      }
      return;
    }
    const blocks = page.locator('#cindy-im-projects-heading');
    if (ui.data.kind === 'none-enabled') {
      assert.equal(await blocks.count(), 0);
      return;
    }
    // 不论开了几个机器人, 区块整页只有一处。
    assert.equal(await blocks.count(), 1);
    if (ui.data.kind === 'plugin-only') {
      assert.ok(await page.getByText('微信群里的 Cindy', { exact: true }).isVisible());
      assert.ok(await page.getByText(await ui.t('settings.remoteControl.hook.form.workspacesCardDescriptionWithPlugins'), { exact: true }).isVisible());
      // 只有插件时没有默认项目单选(那是官方机器人的), 项目照常可改。
      assert.equal(await page.getByRole('radio').count(), 0);
    }
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
