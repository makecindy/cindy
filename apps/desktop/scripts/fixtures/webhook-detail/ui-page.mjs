export default {
  name: 'webhook-detail', entry: './detail-fixture.tsx', viewport: { width: 780, height: 620 },
  real: 'RunHistoryPane, WebhookTriggerPanel, RunHistoryCard, account manager, buttons, translations and theme',
  notCovered: 'Fixture account/status/run data. No real authentication, receiving, model execution or server mutations.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration = () => 0;',
    'src/renderer/hooks/useCCSessions': 'export const useCCSessions = () => ({ sessions: [] });',
    'src/renderer/features/scheduler/hooks/useSessionReferences': 'export const useSessionReferences = () => new Map();',
    'src/renderer/features/scheduler/hooks/useRuns': 'export const useRuns = id => ({ runs: window.__webhookFixtureRuns, runsScheduleId: id, hasLoaded: true, error: null });',
    'src/renderer/lib/sessionAttentionStore': 'export const clearSessionAttentionMany = () => {};',
    'src/renderer/lib/sessionService': 'export const resolveReferences = async () => [];',
    'src/renderer/lib/errorDiagnosisPrompt': 'export const buildErrorDiagnosisPrompt = () => ""; export const prefillErrorDiagnosisDraft = () => {};',
  },
  cases: {
    'app-editing': { about: '编辑时背景详情停止账号读取：返回窗口仅一次读取', data: {} },
    'app-source': { about: 'GitHub App 仓库和事件选择：无需独立地址或密钥', data: {} },
    'app-connected': { about: 'GitHub App 已连接的自动任务', data: {} },
    'app-unauthorized': { about: '账号已连接但仓库未授权：展示缺少权限及授权入口', data: {} },
    'app-disconnected': { about: 'GitHub App 尚未连接的操作提示', data: {} },
    default: { about: '已收到事件：默认简洁摘要，最近运行在首屏', data: {} },
    initial: { about: '首次缺少密钥：自动展开必要配置', data: {} },
    released: { about: '已释放：状态和重新连接始终可见', data: {} },
    offline: { about: '连接中断：异常提示不会藏进设置', data: {} },
    unsupported: { about: '发送方格式不支持：说清是版本不认这个格式，不是暂时不可用', data: {} },
  },
  async ready(page) {
    await page.locator('[role="status"], textarea').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'app-editing') {
      await page.getByRole('button', { name: await ui.t('scheduler.editor.webhook.authorizeRepositories'), exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('scheduler.button.edit'), exact: true }).click();
      await page.getByRole('textbox', { name: await ui.t('scheduler.editor.webhook.repositoriesLabel'), exact: true }).waitFor();
      await page.waitForFunction(() => window.__githubAccountReads === 2);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(() => window.__githubAccountReads === 3);
      if (await page.getByRole('button', { name: await ui.t('scheduler.editor.webhook.authorizeRepositories'), exact: true }).count() !== 1) throw new Error('Only the editor may show account controls');
      await ui.capture('editor-owns-connection');
      return;
    }
    if (ui.case === 'app-source') {
      const repositories = page.getByRole('textbox', { name: await ui.t('scheduler.editor.webhook.repositoriesLabel'), exact: true });
      await repositories.fill('https://github.com/example/project');
      await page.getByText(await ui.t('scheduler.editor.webhook.repositoriesInvalid'), { exact: true }).waitFor();
      await ui.capture('invalid-repository');
      await repositories.fill('makecindy/cindy\nexample/project');
      await page.getByText(await ui.t('scheduler.editor.webhook.repositoriesInvalid'), { exact: true }).waitFor({ state: 'detached' });
      await ui.capture('repositories-and-events');
      await page.getByRole('radio', { name: await ui.t('scheduler.editor.webhook.manualConnection'), exact: true }).check();
      await page.getByText(await ui.t('scheduler.editor.webhook.manualSetupHint'), { exact: true }).waitFor();
      if (await repositories.count()) throw new Error('Manual Webhook must not ask for App repositories');
      await ui.capture('manual-connection');
      await page.getByRole('radio', { name: await ui.t('scheduler.editor.webhook.cindyConnection'), exact: true }).check();
      if (await repositories.inputValue() !== 'makecindy/cindy\nexample/project') throw new Error('Switching connection methods lost repository input');
      return;
    }
    if (ui.case === 'app-unauthorized') {
      await page.getByRole('button', { name: await ui.t('scheduler.editor.webhook.authorizeRepositories'), exact: true }).waitFor();
      await page.getByText(await ui.t('ccAgent.gitContext.pr.setup.app.missing', { repositories: 'example/project' }), { exact: true }).waitFor();
    }
    if (ui.case.startsWith('app-')) {
      await page.getByText(await ui.t('scheduler.editor.webhook.cindyConnectionTitle'), { exact: true }).waitFor();
      if (await page.getByText('https://webhook.example.test/hooks/fixture', { exact: true }).count()) throw new Error('Managed App must not show a task Webhook URL');
      return;
    }
    const toggle = page.getByRole('button', { name: await ui.t('scheduler.webhook.manageConnection'), exact: true });
    if (ui.case === 'initial') {
      if (await toggle.getAttribute('aria-expanded') !== 'true') throw new Error('First setup should open once');
      await toggle.click();
      // The harness resets localStorage on reload; remount the real detail as
      // navigation does, keeping the app's local state intact.
      await page.evaluate(() => window.dispatchEvent(new Event('webhook-fixture-revisit')));
      await page.getByRole('status').first().waitFor();
      if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Revisited setup must stay collapsed even without a secret');
      await toggle.click();
      await page.getByText('https://webhook.example.test/hooks/fixture', { exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('webhook-fixture-revisit')));
      await page.getByRole('status').first().waitFor();
      if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Leaving settings open must not persist the expanded state');
      await ui.capture('revisited-setup');
      return;
    }
    if (ui.case === 'unsupported') {
      await page.getByText(await ui.t('scheduler.webhook.unsupportedFormat'), { exact: true }).waitFor();
      await ui.capture('unsupported-format');
      return;
    }
    if (ui.case !== 'default') return;
    if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Saved connection should start collapsed');
    const runs = page.getByText(await ui.t('scheduler.detail.recentRuns', { count: 1 }), { exact: true });
    const bounds = await runs.boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    if (!bounds || bounds.y + bounds.height > viewportHeight) throw new Error('Recent runs must be visible without scrolling');
    await toggle.click();
    await page.getByRole('button', { name: await ui.t('scheduler.webhook.account.manage'), exact: true }).waitFor();
    await ui.capture('connection-settings');
    await toggle.click();
    await page.getByText('https://webhook.example.test/hooks/fixture', { exact: true }).waitFor({ state: 'detached' });
  },
};
