import assert from 'node:assert/strict';

// 「开启协同」/「创建新 Worker」弹窗：预设、首条任务、收起的「更多设置」。
// 只模拟 preload 读接口；不登录、不联网、不启动 Agent，提交只记录表单。
export default {
  name: 'collab-start',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 760 },
  real: 'CreateWorkerPopover, worker roles and their memory, ModelSelector trigger, PermissionSelector, WorkerProjectField, execution device field, ConfirmDialog, Radix Dialog, translations and themes',
  notCovered:
    'Actual team start and Worker creation, main-side validation and mirroring, the real device-link transport, SSH Leads, model panel contents, native folder dialog and real worktree creation',
  cases: {
    default: { about: 'Start collaboration in an existing task: roles ordered by recent use, adding a role inline, per-role task and settings, hover-to-remove with confirmation' },
    draft: { about: 'New-task draft: no project or device section and no starter task' },
    'add-worker': { about: 'Add a Worker to a running team: same form without the introduction' },
    'missing-project': { about: 'A problem inside More Settings opens the section by itself' },
    remote: { about: 'Task on another computer: that computer’s roles and memory, changes sent to it, nothing kept here' },
  },
  async ready(page) {
    await page.getByRole('dialog').waitFor();
    await page.getByText('Fixture Model', { exact: true }).first().waitFor();
  },
  async check(page, ui) {
    const task = page.getByRole('textbox', { name: await ui.t('orca.createWorker.initialTaskLabel') });
    const template = async (id) =>
      page.getByRole('radio', { name: await ui.t(`orca.createWorker.templates.${id}.name`), exact: true });
    const more = page.getByRole('button', { name: await ui.t('orca.createWorker.moreSettings') });
    const submit = page.getByRole('button', {
      name: await ui.t(
        ui.case === 'add-worker' ? 'orca.createWorker.submit' : 'orca.createWorker.enableCollabSubmit',
      ),
      exact: true,
    });

    if (ui.case === 'remote') {
      // 那台电脑的清单：它加过的角色排在最前并带回记的内容，它移除过的「测试」不出现。
      const saved = page.getByRole('radio', { name: 'researcher', exact: true });
      await saved.waitFor();
      assert.equal(await saved.getAttribute('aria-checked'), 'true');
      assert.equal(await task.inputValue(), 'Read the changelog');
      assert.equal(await (await template('tester')).count(), 0);
      await ui.capture('remote-roles');
      await submit.click();
      await page.waitForFunction(() => globalThis.collabStart.remoteRoleCalls().length === 1);
      const [call] = await page.evaluate(() => globalThis.collabStart.remoteRoleCalls());
      assert.equal(call.args[0].kind, 'remember');
      assert.equal(call.args[0].role, 'researcher');
      assert.equal(call.args[0].task, 'Read the changelog');
      // 不分角色的「上次选择」也交给那台电脑。
      assert.equal(typeof call.args[0].choice?.agent, 'string');
      // 这台电脑自己什么都不记：角色、上次用的 Agent / 模型 / 权限都没写。
      const local = await page.evaluate(() => globalThis.localStorage.getItem('workerCreationPrefs'));
      assert.equal(local, null);
      return;
    }

    if (ui.case === 'missing-project') {
      await page.getByRole('status').getByText(await ui.t('orca.workerProject.missingDirectory')).waitFor();
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      assert.equal(await submit.isDisabled(), true);
      return;
    }

    // 没有上次的选择时停在排第一的「审查」。
    assert.equal(await (await template('reviewer')).getAttribute('aria-checked'), 'true');

    if (ui.case === 'draft') {
      assert.equal(await more.count(), 0);
      assert.equal(await task.inputValue(), '', 'a draft has no Lead work to review yet');
      return;
    }

    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await task.inputValue(), await ui.t('orca.createWorker.templates.reviewer.task'));
    await (await template('developer')).click();
    assert.equal(await task.inputValue(), '');
    await ui.capture('developer-empty-task');

    // 没改过的预设任务跟着预设换；用户写过的内容留着。
    await (await template('tester')).click();
    assert.equal(await task.inputValue(), await ui.t('orca.createWorker.templates.tester.task'));
    await task.fill('Check the login flow only');
    await (await template('developer')).click();
    assert.equal(await task.inputValue(), 'Check the login flow only');

    await page.getByRole('button', { name: await ui.t('orca.createWorker.addRole'), exact: true }).click();
    const role = page.getByRole('textbox', { name: await ui.t('orca.createWorker.roleLabel') });
    await role.waitFor();
    assert.equal(await submit.isDisabled(), true, 'a custom Worker needs a role name');
    await role.fill('researcher');
    await ui.capture('custom-role');

    // 权限菜单从任务框底部展开，必须浮在弹窗之上并且点得到。
    const permission = page.getByTestId('worker-permission-mode').getByRole('button');
    await permission.click();
    await ui.capture('permission-menu');
    await page.getByRole('option').first().click();

    await more.click();
    await page.getByRole('combobox', { name: await ui.t('orca.createWorker.executionDeviceLabel') }).waitFor();
    await page.getByRole('button', { name: await ui.t('orca.workerProject.current'), exact: true }).waitFor();
    await ui.capture('more-settings');

    await submit.click();
    await page.waitForFunction(() => globalThis.collabStart.submitted() !== null);
    const form = await page.evaluate(() => globalThis.collabStart.submitted());
    assert.equal(form.role, 'researcher');
    assert.equal(form.initialTask, 'Check the login flow only');
    assert.equal(form.workerPermissionMode, 'auto');

    // 再次打开：自定义角色留在这一排并被选中，带回上次的文字和权限。
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    const saved = page.getByRole('radio', { name: 'researcher', exact: true });
    assert.equal(await saved.getAttribute('aria-checked'), 'true');
    assert.equal(await task.inputValue(), 'Check the login flow only');
    assert.equal(await role.count(), 0, 'a saved role needs no name input');
    await ui.capture('reopened-with-saved-role');

    // 内置预设没记过文字时仍是自带的一句话；切回自定义角色又带回它的文字。
    await (await template('reviewer')).click();
    assert.equal(await task.inputValue(), await ui.t('orca.createWorker.templates.reviewer.task'));
    await saved.click();
    assert.equal(await task.inputValue(), 'Check the login flow only');

    // 这一排按最近使用排序：刚用过的自定义角色在最前。
    const order = async () => page.getByRole('radio').allTextContents();
    const builtinName = async (id) => ui.t(`orca.createWorker.templates.${id}.name`);
    assert.deepEqual(await order(), [
      'researcher',
      await builtinName('reviewer'),
      await builtinName('developer'),
      await builtinName('tester'),
    ]);

    // 移除按钮平时不显示，鼠标移到角色上才出现；点了先确认，取消则不动。
    const removeButton = async (name) =>
      page.getByRole('button', { name: await ui.t('orca.createWorker.removePreset', { role: name }), exact: true });
    const confirmRemoval = page.getByRole('button', {
      name: await ui.t('orca.createWorker.removePresetConfirm.confirm'),
      exact: true,
    });
    const researcherRemove = await removeButton('researcher');
    const opacityIs = async (value) =>
      page.waitForFunction(
        ([node, expected]) => globalThis.getComputedStyle(node).opacity === expected,
        [await researcherRemove.elementHandle(), value],
      );
    // 上一步刚点过这个角色，先把鼠标移开。
    await page.mouse.move(2, 2);
    await opacityIs('0');
    await ui.capture('roles-at-rest');
    await saved.hover();
    await opacityIs('1');
    await ui.capture('remove-on-hover');
    await researcherRemove.click();
    await confirmRemoval.waitFor();
    await ui.capture('remove-confirmation');
    await page
      .getByRole('button', { name: await ui.t('orca.createWorker.removePresetConfirm.cancel'), exact: true })
      .click();
    // 确认弹窗关闭后表单才重新可操作；角色还在。
    await saved.waitFor();

    // 确认后移除；内置角色也一样能移除。确认弹窗完全关闭、表单重新可操作后再看结果。
    const confirmAndSettle = async () => {
      await confirmRemoval.click();
      await confirmRemoval.waitFor({ state: 'detached' });
      await (await template('reviewer')).waitFor();
    };
    await saved.hover();
    await researcherRemove.click();
    await confirmAndSettle();
    assert.equal(await saved.count(), 0);
    assert.equal(await (await template('reviewer')).getAttribute('aria-checked'), 'true');
    await (await template('tester')).hover();
    await (await removeButton(await builtinName('tester'))).click();
    await confirmAndSettle();
    assert.deepEqual(await order(), [await builtinName('reviewer'), await builtinName('developer')]);
    await ui.capture('roles-removed');
  },
};
