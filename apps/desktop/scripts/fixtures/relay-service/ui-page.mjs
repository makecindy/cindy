import assert from 'node:assert/strict';

export default {
  name: 'relay-service',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'RelayServicePanel, useSelfHostedRelayState, RelayShareDialog and RelayShareGlobalHost: route list with one row per server, icon-only share/switch/rename/remove actions, server details, pending requests, share, approval, deploy, rename, join and host dialogs',
  notCovered: 'Real SSH, deployment, certificate issuance, join codes, joining and switching; covered separately by deployment/runtime unit tests',
  cases: {
    default: { about: 'Official relay in use; a deployed server relay is available to switch to' },
    server: { about: 'Server relay in use: details with devices, certificate and version; no QR code or join link on the page', viewport: { width: 360, height: 900 } },
    host: { about: 'This computer is the relay: share and settings icons' },
    share: { about: 'Sharing the relay in use opens a dialog with a one-time link, QR code and countdown; regenerating issues a new link' },
    pending: { about: 'A join request pops the approval dialog; Decide later keeps it in the relay row, where Review reopens it and approving clears it' },
    account: { about: 'A relay in use on another computer of this account is listed with only a switch icon; switching asks once and joins without a link' },
    tenant: { about: 'Another account asks to use the relay: the approval names the account and explains its separate line; the shared-with list allows stopping after a confirmation' },
    shared: { about: 'A relay shared by another account is in use: it is labelled as shared, has no share icon, and leaving warns that this account\'s devices on it disconnect' },
    'share-own': { about: 'A relay that cannot be shared with other accounts yet says so in the share dialog' },
    'retry-replace': { about: 'A failed replacement rechecks the server and asks again before clearing its relay' },
    'retry-own': { about: 'A failed deployment retains its elapsed time and retries its own relay without clearing it' },
    'retry-existing': { about: 'An existing complete relay keeps an entry to view and retry a redeployment that failed before changing the server' },
    'retry-check-error': { about: 'A failed retry check stays in the deployment dialog with a visible error' },
    'deploy-steady': { about: 'Choosing a server, its check, each deployment step and the finished page keep the dialog and form fields in place' },
    multi: { about: 'Two server relays, one in use; renaming the other and deploying again stay available' },
  },
  async check(page, ui) {
    const route = 'settings.remoteControl.relay.route';
    const relay = 'settings.remoteControl.relay';
    const removeLabel = await ui.t(`${relay}.manage.remove`);
    const serverRow = page.getByRole('listitem').filter({ hasText: 'Test' });
    const serverButtons = serverRow.getByRole('button');
    // #7921 review:真实组件回归替换重试、失败用时和弹窗内错误；旧场景只有成功状态。
    if (ui.case.startsWith('retry-')) {
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
      // 用户 2026-11-09:平时只显示线路信息,分享走弹窗;正在用的中转行上是分享图标,页面上没有二维码和链接。
      const labels = await serverButtons.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      assert.deepEqual(labels.slice(0, 3), [await ui.t(`${relay}.share.action`), await ui.t(`${route}.rename`), removeLabel]);
      assert.equal(await page.getByRole('img', { name: await ui.t(`${relay}.share.qrAlt`) }).count(), 0);
      // 用户 2026-11-11:详情里要看得出中转支持哪些连接、这台电脑现在走的是哪个。
      // 页面把 Agent-Net 的连字符换成不折行连字符，窄屏时名字不会被拆到两行。
      const keepName = (text) => text.replace(/Agent-Net/g, 'Agent‑Net');
      await serverRow.getByText(keepName(await ui.t(`${relay}.manage.protocolsBoth`)), { exact: true }).waitFor();
      await serverRow.getByText(await ui.t(`${relay}.manage.connection`), { exact: true }).waitFor();
      await serverRow.getByText('Device Link', { exact: true }).waitFor();
      await serverRow.getByText(keepName(await ui.t(`${relay}.manage.connectionLegacy`)), { exact: true }).waitFor();
    } else if (ui.case === 'share') {
      await serverRow.getByRole('button', { name: await ui.t(`${relay}.share.action`), exact: true }).click();
      const dialog = page.getByTestId('relay-share-dialog');
      await dialog.getByRole('img', { name: await ui.t(`${relay}.share.qrAlt`), exact: true }).waitFor({ timeout: 3_000 });
      const field = dialog.getByRole('textbox', { name: await ui.t(`${relay}.share.fieldLabel`), exact: true });
      assert.match(await field.inputValue(), /c=first-/);
      await ui.capture('share-dialog');
      await dialog.getByRole('button', { name: await ui.t(`${relay}.share.regenerate`), exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="relay-share-dialog"] input')?.value.includes('c=second-'), null, { timeout: 3_000 });
      await dialog.getByRole('button', { name: await ui.t(`${relay}.share.done`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    } else if (ui.case === 'pending') {
      // 申请自动弹出审批;「稍后处理」后留在中转那一行里,「处理」重新打开,同意后消失。
      const dialog = page.getByTestId('relay-approve-dialog');
      await dialog.waitFor({ timeout: 3_000 });
      assert.equal(await dialog.getByTestId('provider-share-pairing-code').innerText(), '5461');
      await ui.capture('approve-dialog');
      await dialog.getByRole('button', { name: await ui.t(`${relay}.approve.later`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      const review = serverRow.getByRole('button', { name: await ui.t(`${relay}.requests.open`), exact: true });
      await review.waitFor({ timeout: 3_000 });
      await ui.capture('pending-in-row');
      await review.click();
      await dialog.waitFor({ timeout: 3_000 });
      await dialog.getByRole('button', { name: await ui.t(`${relay}.approve.approve`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await review.waitFor({ state: 'detached', timeout: 3_000 });
    } else if (ui.case === 'account') {
      // 用户 2026-11-09:同账号的设备不用链接,直接出现那台电脑的中转,点切换就加入;分享和管理只在那台电脑上。
      const device = 'Lizi MacBook Pro';
      const row = page.getByRole('listitem').filter({ hasText: 'Home relay' });
      await row.getByText(await ui.t(`${route}.accountManagedOn`, { device }), { exact: true }).waitFor();
      assert.deepEqual(
        await row.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
        [await ui.t(`${route}.useNamed`, { name: 'Home relay' })],
      );
      await ui.capture('account-row');
      await row.getByRole('button', { name: await ui.t(`${route}.useNamed`, { name: 'Home relay' }), exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${route}.switchTitle`, { name: 'Home relay' }), exact: true });
      await confirmation.getByText(await ui.t(`${route}.switchToAccount`, { device }), { exact: true }).waitFor();
      await ui.capture('account-confirm');
      await confirmation.getByRole('button', { name: await ui.t(`${route}.switchConfirm`), exact: true }).click();
      await page.locator('li[aria-current="true"]').filter({ hasText: 'Home relay' }).waitFor({ timeout: 3_000 });
      // 加入后仍是那一行被选中,不再另起一行「已加入」。
      assert.equal(await page.getByRole('listitem').filter({ hasText: 'Home relay' }).count(), 1);
    } else if (ui.case === 'tenant') {
      // 用户 2026-11-09:给非同账号分享。审批说清楚对方拿到的是自己独立的线路;分享给的账号可以随时停止。
      const dialog = page.getByTestId('relay-approve-dialog');
      await dialog.getByText(await ui.t(`${relay}.approve.titleAccount`, { account: 'Bob', relay: 'Test' }), { exact: true }).waitFor({ timeout: 3_000 });
      await dialog.getByText(await ui.t(`${relay}.approve.calloutAccount`, { relay: 'Test' }), { exact: true }).waitFor();
      assert.equal(await dialog.getByTestId('provider-share-pairing-code').innerText(), '0712');
      await ui.capture('approve-account');
      await dialog.getByRole('button', { name: await ui.t(`${relay}.approve.approve`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      const tenants = page.getByTestId('relay-tenants');
      await tenants.getByText('Bob', { exact: true }).waitFor({ timeout: 3_000 });
      const alice = tenants.getByRole('listitem').filter({ hasText: 'Alice' });
      await alice.getByText(await ui.t(`${relay}.tenants.devices`, { count: 2 }), { exact: false }).waitFor();
      await ui.capture('tenants');
      await alice.getByRole('button', { name: await ui.t(`${relay}.tenants.revoke`), exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${relay}.tenants.revokeTitle`, { account: 'Alice' }), exact: true });
      await confirmation.getByRole('button', { name: await ui.t(`${relay}.tenants.revoke`), exact: true }).click();
      // The confirmation temporarily hides the background from the accessibility
      // tree. Wait for its close before counting the remaining account rows.
      await confirmation.waitFor({ state: 'detached' });
      await alice.waitFor({ state: 'detached', timeout: 3_000 });
      assert.equal(await tenants.getByRole('listitem').count(), 1);
    } else if (ui.case === 'shared') {
      const row = page.getByRole('listitem').filter({ hasText: 'Lizi relay' });
      assert.equal(await row.getAttribute('aria-current'), 'true');
      await row.getByText(await ui.t(`${route}.kindShared`), { exact: true }).waitFor();
      await row.getByText(await ui.t(`${route}.sharedBy`, { name: 'Lizi' }), { exact: true }).waitFor();
      // 别人分享来的中转不能再分享出去。
      assert.equal(await row.getByRole('button', { name: await ui.t(`${relay}.share.action`), exact: true }).count(), 0);
      await page.getByText(await ui.t(`${route}.sharedOwnDevicesHint`), { exact: true }).waitFor();
      await ui.capture('shared-row');
      const official = await ui.t(`${relay}.summary.official`);
      await page.getByRole('button', { name: await ui.t(`${route}.useNamed`, { name: official }), exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${relay}.confirm.sharedOwnerTitle`), exact: true });
      await confirmation.getByText(await ui.t(`${relay}.confirm.sharedOwnerDescription`, { name: 'Lizi relay' }), { exact: true }).waitFor();
      await ui.capture('shared-leave');
      await confirmation.getByRole('button', { name: await ui.t(`${relay}.actions.useOfficial`), exact: true }).click();
      await page.getByRole('listitem').filter({ hasText: 'Lizi relay' }).waitFor({ state: 'detached', timeout: 3_000 });
    } else if (ui.case === 'share-own') {
      await serverRow.getByRole('button', { name: await ui.t(`${relay}.share.action`), exact: true }).click();
      const dialog = page.getByTestId('relay-share-dialog');
      await dialog.getByTestId('relay-share-own-account-only').waitFor({ timeout: 3_000 });
      assert.equal(await dialog.getByTestId('relay-share-own-account-only').innerText(), await ui.t(`${relay}.share.ownAccountOnly`));
      // 2026-11-10 实机:只能给自己设备用(V1)时,弹窗不能再说「对方账号可以用」「全程加密」。
      await dialog.getByText(await ui.t(`${relay}.share.descriptionOwn`), { exact: true }).waitFor();
      for (const key of ['description', 'calloutIsolation', 'calloutPrivacy', 'scanHint']) {
        assert.equal(await dialog.getByText(await ui.t(`${relay}.share.${key}`), { exact: true }).count(), 0, `own-only dialog shows ${key}`);
      }
      await ui.capture('share-own-account-only');
    } else {
      const settings = page.getByRole('button', { name: await ui.t(`${relay}.actions.editHost`), exact: true });
      await settings.click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${route}.hostTitle`) });
      await dialog.waitFor();
      await ui.capture('host-dialog');
    }
  },
};
