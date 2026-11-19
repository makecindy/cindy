export default {
  name: 'goal-indicator',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 400 },
  real: 'GoalIndicator, useGoalStatus and ErrorNotice',
  notCovered: 'Agent execution and main-process recovery; host state is synthetic.',
  cases: {
    default: {
      about: 'Specific blocked reason',
      data: { reason: 'The sample feedback file is missing. Add the file to this task.' },
    },
    long: {
      about: 'Scrollable long reason in a narrow view',
      data: { reason: 'The feedback file is missing.\n'.repeat(20) + 'END-OF-REASON' },
      viewport: { width: 360, height: 420 },
    },
    unknown: { about: 'No reason provided', data: { reason: null } },
    loop: { about: 'Localized tool loop reason', data: { reason: 'tool_use_loop_detected' } },
    technical: {
      about: 'Expandable technical details',
      data: { reason: 'turn dispatch failed: unable to restore the agent session' },
    },
  },
  async check(page, ui) {
    await page.getByText(await ui.t('goal.status.blocked'), { exact: true }).waitFor();
    if (ui.case === 'technical') {
      await page
        .getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw') })
        .click();
      await page.getByText(ui.data.reason, { exact: true }).waitFor();
    } else if (ui.case === 'unknown') {
      await page.getByText(await ui.t('goal.blockedReasonUnknown'), { exact: true }).waitFor();
    } else if (ui.case === 'loop') {
      await page
        .getByText(await ui.t('logic.errors.toolUseLoopDetected'), { exact: true })
        .waitFor();
    } else {
      await page.getByText(ui.data.reason, { exact: true }).waitFor();
    }
  },
};
