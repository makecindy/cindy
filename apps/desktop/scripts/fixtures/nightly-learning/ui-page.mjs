import assert from 'node:assert/strict';

/** 伙伴设置「例行任务」里的夜间学习行与学习记录页（docs/product-rules/bot-routines.md「内置夜间学习」）。 */
export default {
  name: 'nightly-learning',
  entry: './nightly-learning-fixture.tsx',
  viewport: { width: 620, height: 1100 },
  real: 'BotRoutines (built-in rows, nightly status lines and entry), BotNightlyLearning (switch, frequency, run now, history with undo/restore, approaches being watched), Switch, SegmentedControl, theme and translations',
  notCovered: 'The host job itself (model call, memory and skill writes), routine scheduling, the settings drawer chrome, Mobile',
  stubs: {},
  cases: {
    default: { about: 'Pending conversations, last night learned five changes (one already undone), two approaches being watched' },
    idle: { about: 'Nothing new since the last run; the next run will be skipped without calling a model' },
    paused: { about: 'Turned off: conversations are still counted' },
    failed: { about: 'Last run failed; weekly frequency; memory turned off' },
    new: { about: 'Never run yet' },
    'not-here': { about: 'This computer is not the teammate’s main computer: no nightly row, history page explains why' },
  },
  async ready(page) {
    await page.getByRole('switch').first().waitFor();
  },
  async check(page, ui) {
    const entry = page.getByRole('button', { name: await ui.t('routines.nightly.viewHistory') });
    if (ui.case === 'not-here') {
      assert.equal(await entry.count(), 0, 'no nightly row on another computer');
      return;
    }
    await ui.capture('routines');
    await entry.click();
    await page.getByRole('heading', { name: await ui.t('routines.builtinNightlyLearning.title') }).waitFor();
    if (ui.case === 'default') {
      await page.getByRole('button', { name: await ui.t('routines.nightly.watching') }).click();
      await page.getByRole('button', { name: await ui.t('routines.nightly.promote') }).first().waitFor({ state: 'visible' });
      await page.getByRole('button', { name: await ui.t('routines.nightly.undo') }).first().click();
      await page.getByRole('button', { name: await ui.t('routines.nightly.redo') }).nth(1).waitFor();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal overflow');
    await ui.capture('history');
  },
};
