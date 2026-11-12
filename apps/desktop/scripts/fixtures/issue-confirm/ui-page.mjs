import assert from 'node:assert/strict';
export default {
  name: 'issue-confirm',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 620 },
  real: 'IssueConfirmCard, MarkdownRenderer, draft persistence and public submission controls',
  notCovered: 'GitHub publication, remote transport and main-process validation; data is synthetic',
  cases: {
    default: { about: 'Review before publishing; edit and identity details on demand' },
    narrow: { about: 'Narrow desktop conversation column', viewport: { width: 400, height: 760 } },
  },
  async check(page, ui) {
    assert.equal(await page.getByRole('textbox').count(), 0);
    await page
      .getByRole('button', { name: await ui.t('issueAgent.confirm.edit'), exact: true })
      .click();
    await page
      .getByLabel(await ui.t('issueAgent.confirm.titleLabel'))
      .fill('手机无法完成反馈确认（已补充）');
    assert.equal(
      await page
        .getByRole('button', { name: new RegExp(await ui.t('issueAgent.confirm.publicSubmit')) })
        .count(),
      0,
    );
    await ui.capture('editing');
    await page
      .getByRole('button', { name: await ui.t('issueAgent.confirm.doneEditing'), exact: true })
      .last()
      .click();
    await page
      .getByRole('heading', { name: '手机无法完成反馈确认（已补充）', exact: true })
      .waitFor();
    await page
      .getByText(await ui.t('issueAgent.confirm.identitySettings'), { exact: true })
      .click();
    await page.getByLabel(await ui.t('issueAgent.confirm.publicNameLabel')).waitFor();
    await ui.capture('identity');
    await page
      .getByText(await ui.t('issueAgent.confirm.identitySettings'), { exact: true })
      .click();
  },
};
