import assert from 'node:assert/strict';

export default {
  name: 'performance-trace',
  entry: './entry.tsx',
  viewport: { width: 720, height: 600 },
  real: 'PerformanceTrace, MenuButton, DropdownMenu, ConfirmDialog, Button, recording probe and all five locale catalogs',
  notCovered:
    'Native capture, IPC sender authorization, network submission and shared-task hooks; capture has a separate isolated Electron smoke test',
  stubs: {
    'src/renderer/features/device-link/useSharedTaskTasks':
      'export function useSharedTaskTasks() {}',
    'src/renderer/features/device-link/SharedTaskEndedNotice':
      'export const SharedTaskEndedNotice = () => null;',
  },
  cases: {
    'main-menu': {
      about: 'Main window offers performance tracing',
      viewport: { width: 360, height: 500 },
    },
    'secondary-menu': {
      about: 'Secondary window hides the unsupported trace action',
      viewport: { width: 360, height: 500 },
    },
    default: { about: 'Start instructions and local-only scope' },
    recording: { about: 'Non-modal recording status and stop action' },
    ready: { about: 'Completed report, optional description and local files' },
    partial: { about: 'Incomplete capture is explicitly disclosed' },
    'upload-failed': { about: 'Submission failure preserves the description and permits retry' },
    narrow: { about: 'Completed report at narrow width', viewport: { width: 320, height: 640 } },
    reopened: {
      about: 'Menu reentry offers recording first; previous report requires an explicit action',
      viewport: { width: 320, height: 640 },
    },
    'reopened-submitted': {
      about: 'Submitted previous report keeps its ID without becoming the default view',
    },
  },
  async ready(page) {
    await page.getByRole('button').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case.endsWith('-menu')) {
      await page.getByRole('button', { name: await ui.t('titleBar.menu'), exact: true }).click();
      await page.getByRole('menu').waitFor();
      assert.equal(
        await page
          .getByRole('menuitem', { name: await ui.t('performanceTrace.title'), exact: true })
          .count(),
        ui.case === 'secondary-menu' ? 0 : 1,
      );
      return;
    }
    if (ui.case === 'recording') {
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.stop'), exact: true })
          .isVisible(),
      );
      return;
    }
    assert.ok(
      await page.getByText(await ui.t('performanceTrace.localScope'), { exact: true }).isVisible(),
    );
    if (ui.case.startsWith('reopened')) {
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.start'), exact: true })
          .isEnabled(),
      );
      assert.equal(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.submit'), exact: true })
          .count(),
        0,
      );
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.previous'), exact: true })
        .click();
      await page
        .getByRole('alertdialog', {
          name: await ui.t('performanceTrace.previousResult'),
          exact: true,
        })
        .waitFor();
      if (ui.case === 'reopened-submitted') {
        await page
          .getByText(await ui.t('performanceTrace.uploaded', { id: 'ABCD-EFGH' }), { exact: true })
          .waitFor();
      } else {
        assert.ok(
          await page
            .getByRole('button', { name: await ui.t('performanceTrace.submit'), exact: true })
            .isEnabled(),
        );
      }
    }
    if (ui.case === 'default') {
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.start'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.stop'), exact: true })
        .click();
      await page.getByRole('textbox').fill('Slow task switching');
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.submit'), exact: true })
        .click();
      await page
        .getByText(await ui.t('performanceTrace.uploaded', { id: 'ABCD-EFGH' }), { exact: true })
        .waitFor();
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.new'), exact: true })
          .isEnabled(),
      );
    }
    if (ui.case === 'upload-failed') {
      await page.getByRole('textbox').fill('Reproduced while switching tasks');
      await page
        .getByRole('button', { name: await ui.t('performanceTrace.submit'), exact: true })
        .click();
      await page.getByRole('alert').waitFor();
      assert.equal(
        await page.getByRole('textbox').inputValue(),
        'Reproduced while switching tasks',
      );
      assert.ok(
        await page
          .getByRole('button', { name: await ui.t('performanceTrace.keepLocal'), exact: true })
          .isEnabled(),
      );
    }
  },
};
