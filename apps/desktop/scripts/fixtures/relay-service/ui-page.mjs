import assert from 'node:assert/strict';

async function assertPublicAgentPreview(page) {
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /https?:\/\/|@|(?:\d{1,3}\.){3}\d{1,3}|\/(?:Users|home|private)\/|demo-server|backup-server|sshHostId|relayId|deploymentKey/,
    'public Agent screenshots must omit addresses, SSH identities and deployment context',
  );
}

export default {
  name: 'relay-service',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'RelayServicePanel, useSelfHostedRelayState and relayAgentTask: route list, server details, dialogs, local task creation and deployment draft handoff',
  notCovered: 'Real SSH, deployment, certificates, joining or switching; public images hide connection details and show a generic task handoff placeholder, not the task editor or an Agent run',
  cases: {
    default: { about: 'Official relay in use; a deployed server relay is available to switch to' },
    server: { about: 'Server relay in use: details with devices, certificate and version', viewport: { width: 360, height: 900 } },
    host: { about: 'This computer is the relay: settings icon and its add-device area' },
    'retry-replace': { about: 'A failed replacement rechecks the server and asks again before clearing its relay' },
    'retry-own': { about: 'A failed deployment retains its elapsed time and retries its own relay without clearing it' },
    'retry-existing': { about: 'An existing complete relay keeps an entry to view and retry a redeployment that failed before changing the server' },
    'retry-check-error': { about: 'A failed retry check stays in the deployment dialog with a visible error' },
    'deploy-steady': { about: 'Choosing a server, its check, each deployment step and the finished page keep the dialog and form fields in place' },
    multi: { about: 'Two server relays, one in use; renaming the other and deploying again stay available' },
    'agent-no-hosts': { about: 'Agent deployment can open a local task without a configured SSH host or fixed-installer precheck' },
    'agent-selected-host': { about: 'Selected SSH host becomes task context, never the task execution machine' },
    'agent-upgrade': { about: 'An Agent-managed relay opens an upgrade task instead of invoking the fixed installer' },
    'agent-remove': { about: 'An Agent-managed relay opens a removal task instead of invoking the fixed uninstaller' },
    'agent-resume': { about: 'An unfinished Agent deployment resumes using its saved relay identity' },
  },
  async check(page, ui) {
    const route = 'settings.remoteControl.relay.route';
    const relay = 'settings.remoteControl.relay';
    const removeLabel = await ui.t(`${relay}.manage.remove`);
    const serverRow = page.getByRole('listitem').filter({ hasText: 'Test' });
    const serverButtons = serverRow.getByRole('button');
    // #7921 review:真实组件回归替换重试、失败用时和弹窗内错误；旧场景只有成功状态。
    if (ui.case.startsWith('agent-')) {
      await assertPublicAgentPreview(page);
      let action = 'deploy';
      if (ui.case === 'agent-upgrade') {
        action = 'upgrade';
        await serverRow.getByRole('button', { name: await ui.t(`${relay}.agent.upgrade`), exact: true }).click();
      } else if (ui.case === 'agent-remove') {
        action = 'remove';
        await serverRow.getByRole('button', { name: removeLabel, exact: true }).click();
      } else if (ui.case === 'agent-resume') {
        action = 'resume';
        await serverRow.getByRole('button', { name: await ui.t(`${route}.resume`), exact: true }).click();
      } else {
        await page.getByRole('button', { name: await ui.t(`${relay}.agent.deploy`), exact: true }).click();
        const dialog = page.getByRole('dialog', { name: await ui.t(`${relay}.agent.deploy`), exact: true });
        // Capture the choice before selecting a host: no SSH identity enters public evidence.
        await assertPublicAgentPreview(page);
        await ui.capture('agent-deploy-dialog');
        if (ui.case === 'agent-selected-host') {
          await dialog.getByRole('combobox', { name: await ui.t(`${relay}.agent.serverPlaceholder`) }).click();
          await page.getByRole('option').filter({ hasText: 'demo-server' }).click();
        }
        const proceed = dialog.getByRole('button', { name: await ui.t(`${relay}.agent.continue`), exact: true });
        assert.ok(await proceed.isEnabled());
        await proceed.click();
      }
      const task = page.getByTestId('relay-agent-task');
      await task.waitFor();
      const prompt = await page.evaluate((id) => globalThis.__relayAgentDraft(id), await task.getAttribute('data-session-id'));
      assert.ok(prompt.includes(await ui.t(`${relay}.agent.prompt.${action}`)));
      if (ui.case === 'agent-selected-host') assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('{'))), {
        sshHostId: 'demo-server', host: '203.0.113.10', user: 'root',
      });
      else if (action === 'deploy') assert.ok(!prompt.includes('demo-server'));
      else assert.ok(prompt.includes('11111111-1111-4111-8111-111111111111'));
      await assertPublicAgentPreview(page);
    } else if (ui.case.startsWith('retry-')) {
      const deploy = `${relay}.deploy`;
      // #7971 review:重新部署在改动服务器前失败时旧记录仍完整,原分支隐藏了查看和重试入口。
      if (ui.case === 'retry-existing') {
        assert.ok(await page.getByRole('button', { name: await ui.t(`${route}.resume`), exact: true }).isVisible(), 'failed redeployment has no resume entry');
      }
      await page.getByRole('button', { name: await ui.t(`${route}.resume`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${deploy}.title`), exact: true });
      await dialog.waitFor();
      if (ui.case === 'retry-own') {
        await dialog.getByText(await ui.t(`${deploy}.elapsed`, { time: '0:15' }), { exact: true }).waitFor({ timeout: 3_000 });
        await ui.capture('failed-elapsed');
      }
      await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).click();
      if (ui.case === 'retry-replace') {
        const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${deploy}.replaceTitle`), exact: true });
        await confirmation.waitFor({ timeout: 3_000 });
        await ui.capture('replacement-confirmation');
        await confirmation.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
        await dialog.waitFor();
        assert.ok(await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).isVisible());
        await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).click();
        await confirmation.getByRole('button', { name: await ui.t(`${deploy}.submitReplace`), exact: true }).click();
      }
      if (ui.case === 'retry-check-error') {
        await dialog.getByRole('alert').filter({ hasText: await ui.t(`${relay}.errors.PORT_BUSY_CONTAINER`, { detail: 'demo-nginx' }) }).waitFor({ timeout: 3_000 });
        assert.ok(await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).isVisible());
        await ui.capture('retry-check-error');
      } else {
        // 用户 2026-10-30：部署完成不自动切换。完成页给「使用这条线路」,切换照常先确认。
        await dialog.getByText(await ui.t(`${relay}.dialog.doneTitle`, { name: 'Test' }), { exact: true }).waitFor({ timeout: 3_000 });
        // 窗口打开时列表对读屏隐藏,这里按 DOM 查:服务器那一行没有被选中。
        const inUseRow = page.locator('li[aria-current="true"]');
        assert.equal(await inUseRow.filter({ hasText: 'Test' }).count(), 0);
        const use = dialog.getByRole('button', { name: await ui.t(`${relay}.dialog.use`), exact: true });
        await ui.capture('done');
        if (ui.case === 'retry-own') {
          await use.click();
          const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${route}.switchTitle`, { name: 'Test' }), exact: true });
          await confirmation.getByRole('button', { name: await ui.t(`${route}.switchConfirm`), exact: true }).click();
          await inUseRow.filter({ hasText: 'Test' }).waitFor({ timeout: 3_000 });
        } else {
          await dialog.getByRole('button', { name: await ui.t(`${relay}.dialog.finish`), exact: true }).click();
          await dialog.waitFor({ state: 'detached' });
          assert.equal(await page.getByRole('listitem').first().getAttribute('aria-current'), 'true');
        }
      }
    } else if (ui.case === 'deploy-steady') {
      // 用户 2026-10-30 反馈部署过程中窗口高度来回跳:选服务器、检查出结果、开始部署、
      // 每一步推进时,窗口位置和大小都不变,表单的输入框和步骤列表也不被推动。
      const deploy = `${relay}.deploy`;
      await page.getByRole('button', { name: await ui.t(`${relay}.actions.deploy`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${deploy}.title`), exact: true });
      await dialog.waitFor();
      const frame = await dialog.boundingBox();
      const assertFrame = async (moment) => {
        const box = await dialog.boundingBox();
        assert.deepEqual([box.y, box.height], [frame.y, frame.height], `deploy dialog moved or resized: ${moment}`);
      };
      const address = dialog.getByRole('textbox', { name: await ui.t(`${deploy}.address`), exact: true });
      const addressY = (await address.boundingBox()).y;
      const assertForm = async (moment) => {
        await assertFrame(moment);
        assert.equal((await address.boundingBox()).y, addressY, `address field moved: ${moment} (${(await address.boundingBox()).y} vs ${addressY})`);
      };
      await ui.capture('form-idle');
      await dialog.getByRole('combobox', { name: await ui.t(`${deploy}.serverPlaceholder`) }).click();
      await page.getByRole('option').first().click();
      await dialog.getByText(await ui.t(`${deploy}.check.checking`), { exact: true }).waitFor();
      await assertForm('checking');
      await ui.capture('form-checking');
      await dialog.getByRole('status').filter({ hasText: await ui.t(`${deploy}.check.ready`) }).waitFor({ timeout: 3_000 });
      await assertForm('ready');
      await ui.capture('form-ready');
      await dialog.getByRole('button', { name: await ui.t(`${deploy}.submit`), exact: true }).click();
      await dialog.getByRole('progressbar').waitFor();
      await assertFrame('progress');
      const steps = dialog.getByRole('list').last().getByRole('listitem');
      const stepY = () => steps.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().y));
      const initialStepY = await stepY();
      const progress = [['runtime'], ['runtime', 'runtime-download'], ['runtime', 'runtime-extract'], ['upload'], ['configure', 'nginx-prepare'], ['certificate', 'certificate-wait']];
      for (const [step, message] of progress) {
        await page.evaluate(([s, m]) => globalThis.__relayDeployAdvance(s, m), [step, message]);
        await dialog.locator('[aria-current="step"]').filter({ hasText: await ui.t(`${deploy}.steps.${step}`) }).waitFor();
        const moment = `${step} ${message ?? ''}`;
        await assertFrame(moment);
        assert.deepEqual(await stepY(), initialStepY, `steps moved: ${moment}`);
      }
      await ui.capture('progress-certificate');
      await page.evaluate(() => globalThis.__relayDeployFinish());
      await dialog.getByText(await ui.t(`${relay}.dialog.doneTitle`, { name: await ui.t(`${deploy}.defaultName`) }), { exact: true }).waitFor();
      await assertFrame('done');
      assert.ok(await dialog.getByRole('button', { name: await ui.t(`${relay}.dialog.use`), exact: true }).isVisible());
      await ui.capture('done');
    } else if (ui.case === 'multi') {
      // 用户 2026-10-30：能部署多台服务器，部署完能改名。每台一行；没在用的那台可以切换、改名、移除。
      const backupRow = page.getByRole('listitem').filter({ hasText: 'Backup' });
      assert.equal(await serverRow.getAttribute('aria-current'), 'true');
      assert.ok(await serverRow.getByText(await ui.t(`${relay}.manage.deviceCount`, { count: 3 }), { exact: true }).isVisible());
      assert.deepEqual(
        await backupRow.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
        [await ui.t(`${route}.useNamed`, { name: 'Backup' }), await ui.t(`${route}.rename`), removeLabel],
      );
      assert.ok(await page.getByRole('button', { name: await ui.t(`${relay}.actions.deploy`), exact: true }).isEnabled());
      await backupRow.getByRole('button', { name: await ui.t(`${route}.rename`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${route}.rename`), exact: true });
      const input = dialog.getByRole('textbox', { name: await ui.t(`${relay}.deploy.name`), exact: true });
      await input.fill('Office');
      await ui.capture('rename-dialog');
      await input.press('Enter');
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('listitem').filter({ hasText: 'Office' }).waitFor({ timeout: 3_000 });
    } else if (ui.case === 'default') {
      // 切换在前、改名和删除在后,都只有图标。
      const switchLabel = await ui.t(`${route}.useNamed`, { name: 'Test' });
      assert.equal(await serverButtons.count(), 3);
      assert.equal(await serverButtons.nth(0).getAttribute('aria-label'), switchLabel);
      assert.equal(await serverButtons.nth(1).getAttribute('aria-label'), await ui.t(`${route}.rename`));
      assert.equal(await serverButtons.nth(2).getAttribute('aria-label'), removeLabel);
      assert.equal((await serverButtons.nth(0).innerText()).trim(), '');
      // 右侧只放图标、贴右对齐:只有一个图标的行它就在最右边;正在使用的绿点在线路名旁边,
      // 不挤进图标列(用户 2026-10-29 反馈没对齐、单个切换图标要靠右)。
      const hostTitle = await ui.t(`${route}.hostTitle`);
      const hostSwitch = page
        .getByRole('listitem')
        .filter({ hasText: hostTitle })
        .getByRole('button', { name: await ui.t(`${route}.useNamed`, { name: hostTitle }), exact: true });
      // 新部署随时可以开始,不因为已有一台服务器而隐藏。
      assert.ok(await page.getByRole('button', { name: await ui.t(`${relay}.actions.deploy`), exact: true }).isEnabled());
      const inUse = page.getByRole('listitem').first().getByRole('img', { name: await ui.t(`${relay}.server.inUse`), exact: true });
      const [serverSwitchBox, removeBox, hostSwitchBox, inUseBox] = await Promise.all(
        [serverButtons.nth(0), serverButtons.nth(2), hostSwitch, inUse].map((locator) => locator.boundingBox()),
      );
      assert.equal(hostSwitchBox.x + hostSwitchBox.width, removeBox.x + removeBox.width);
      assert.ok(removeBox.x >= serverSwitchBox.x + serverSwitchBox.width);
      assert.ok(inUseBox.x + inUseBox.width < serverSwitchBox.x);
      // 加入别的中转用窗口,不在列表下面展开。
      await page.getByRole('button', { name: await ui.t(`${relay}.actions.join`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${relay}.join.title`) });
      await dialog.waitFor();
      await ui.capture('join-dialog');
      await dialog.getByRole('button', { name: await ui.t(`${relay}.join.cancel`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    } else if (ui.case === 'server') {
      assert.ok(await serverRow.getByText(await ui.t(`${relay}.manage.deviceCount`, { count: 3 }), { exact: true }).isVisible());
      assert.equal(await serverRow.getByRole('button', { name: removeLabel, exact: true }).count(), 1);
    } else {
      const settings = page.getByRole('button', { name: await ui.t(`${relay}.actions.editHost`), exact: true });
      await settings.click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${route}.hostTitle`) });
      await dialog.waitFor();
      await ui.capture('host-dialog');
    }
  },
};
