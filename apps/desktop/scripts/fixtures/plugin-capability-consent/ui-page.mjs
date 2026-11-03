export default {
  name: 'plugin-capability-consent',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 600 },
  real: 'GhostInstallConsentHost, shared confirmation dialog, capability and update permission rows, all supported locales and themes',
  notCovered: 'Real installation, permission receipt writes, OAuth, plugin execution and native mobile rendering',
  cases: {
    default: { about: 'Existing task declaration waiting for independent approval' },
    'pending-ui': { about: 'Existing UI declaration waiting for independent approval' },
    'added-permission': { about: 'A package update actually adds a permission' },
  },
  async check(page, ui) {
    const selected = await page.evaluate(() => window.__uiPage.ctx.case);
    const added = selected === 'added-permission';
    const task = selected === 'default';
    await ui.emit('installConsent', {
      requestId: 'fixture-consent',
      ...(added ? {} : { purpose: task ? 'task-capability' : 'ui-capability' }),
      initiator: 'user', origin: 'local-file',
      facts: {
        kind: 'update', ghostId: 'fixture-plugin', name: 'Plugin',
        version: added ? '2.0.0' : '1.0.0', previousVersion: '1.0.0',
        added: [added
          ? { key: 'network:host:example.test', kind: 'network', labelKey: 'networkHost', labelArgs: { host: 'example.test' } }
          : task
            ? { key: 'agent:tasks', kind: 'agent', labelKey: 'agentTasks', detailKey: 'agentTasksDetail' }
            : { key: 'ui:pages', kind: 'panel', labelKey: 'mcpUi', detailKey: 'uiPageAccess', detailArgs: { pages: 'ui://fixture/page', domains: 'example.test', tools: 'fixture' } }],
        removed: [], unchangedCount: 14, builtinOauthClientChanged: false,
      },
    });
    const heading = added ? 'addedTitle' : 'pendingTitle';
    await page.getByText(await ui.t(`settings.ghosts.installConsent.${heading}`), { exact: true }).waitFor();
    if (added) {
      await page.getByText(await ui.t('settings.ghosts.installConsent.addedBadge'), { exact: true }).waitFor();
    } else {
      await page.getByText(await ui.t('settings.ghosts.installConsent.capabilityDescription'), { exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('settings.ghosts.connections.confirmAllow'), exact: true }).waitFor();
      for (const key of ['addedTitle', 'addedBadge']) {
        if (await page.getByText(await ui.t(`settings.ghosts.installConsent.${key}`), { exact: true }).count())
          throw new Error('Pending capability approval must not claim new permissions');
      }
    }
  },
};
