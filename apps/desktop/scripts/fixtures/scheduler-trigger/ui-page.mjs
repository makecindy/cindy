import assert from 'node:assert/strict';

export default {
  name: 'scheduler-trigger', entry: './trigger-fixture.tsx', viewport: { width: 1100, height: 900 },
  real: 'ScheduleFormDialog, form state, Webhook fields, Collapse, segmented controls, dialog positioning and theme',
  notCovered: 'Fixture catalogs/account; model and project picker buttons are placeholders. No server writes.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration = () => 0;',
    'src/renderer/hooks/useAgentCapabilities': './catalog-hooks.ts',
    'src/renderer/hooks/useProviders': './catalog-hooks.ts',
    'src/renderer/hooks/useDeviceProviders': './catalog-hooks.ts',
    'src/renderer/hooks/useFeishuBot': 'export const useFeishuBot = () => ({status: "disconnected"});',
    'src/renderer/hooks/useWecomGroupNotificationSettings': 'export const useWecomGroupNotificationSettings = () => ({});',
    'src/renderer/hooks/useProjectPickerOptions': 'export const useProjectPickerOptions = () => [];',
    'src/renderer/features/scheduler/hooks/useSessionReferences': 'export const useSessionReferences = () => new Map();',
    'src/renderer/lib/sessionService': 'export const resolveReferences = async () => [];',
    'src/renderer/features/scheduler/components/BoundSessionCard': 'export const BoundSessionCard = () => null;',
    'src/renderer/features/scheduler/components/TemplateGallery': 'export const TemplateGallery = () => null;',
    'src/renderer/features/scheduler/components/ScheduleChips': `import React from 'react'; const chip = label => React.createElement('button', {type: 'button', style: {height: 34}}, label); export const ProjectChip = () => chip('对话'); export const ModelEffortChip = () => chip('Codex'); export const ScheduleChip = () => chip('09:00'); export const ScheduleSettingsButton = () => null; export const ThreadPickerInline = () => null;`,
  },
  cases: { default: { about: 'Webhook → 手动 → 定时 → Webhook，弹窗及触发选择器不跳动' },
    create: { about: '新建表单使用相同的稳定切换布局' },
    scrolled: { about: '小窗口滚动后切换触发方式，配置区收起不拉回滚动位置', viewport: { width: 780, height: 620 } } },
  async ready(page) {
    const label = await page.evaluate(() => window.__uiPage.t('scheduler.editor.webhook.eventPicker.choose'));
    await page.getByRole('button', { name: label, exact: true }).waitFor();
  },
  async check(page, ui) {
    // Regression: the previous centered, content-sized dialog shrank immediately
    // when Webhook fields unmounted, then grew while run settings expanded.
    // jsdom form tests cannot observe rendered geometry; sample actual paint frames.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const [key, capture] of [['scheduler.editor.fields.manually', 'manual'],
      ['scheduler.editor.trigger.timed', 'timed'], ['scheduler.cell.tagWebhook', 'webhook']]) {
      const label = await ui.t(key);
      const choice = page.getByRole('radio', { name: label, exact: true });
      // UI regression: removing Webhook fields used to clamp scrollTop and move
      // this control by 144px in a short window. Start measuring after the user
      // has scrolled the control into view, not before Playwright's auto-scroll.
      await choice.scrollIntoViewIfNeeded();
      await choice.evaluate((element, triggerLabel) => {
        const frames = []; window.__triggerFrames = frames; window.__triggerFramesDone = false;
        const sample = () => {
          const box = document.querySelector('[role="dialog"]').getBoundingClientRect();
          const trigger = [...document.querySelectorAll('[role="radiogroup"]')]
            .find(el => el.getAttribute('aria-label') === triggerLabel).getBoundingClientRect();
          const prompt = document.querySelector('textarea').getBoundingClientRect();
          frames.push({y: box.y, height: box.height, triggerY: trigger.y, triggerX: trigger.x, promptY: prompt.y});
        };
        sample();
        element.addEventListener('click', () => {
          const until = performance.now() + 500;
          const tick = () => { sample();
            if (performance.now() < until) requestAnimationFrame(tick);
            else window.__triggerFramesDone = true;
          }; tick();
        }, {once: true});
      }, await ui.t('scheduler.editor.trigger.label'));
      await choice.click();
      await page.waitForFunction(() => window.__triggerFramesDone);
      const frames = await page.evaluate(() => window.__triggerFrames);
      const spread = key => Math.max(...frames.map(f => f[key])) - Math.min(...frames.map(f => f[key]));
      console.log(`trigger ${label}: dialogY ${spread('y').toFixed(1)}px, height ${spread('height').toFixed(1)}px, choiceY ${spread('triggerY').toFixed(1)}px`);
      await ui.capture(capture);
      assert.ok(['y', 'height', 'triggerY', 'triggerX'].every(key => spread(key) < 1), `Trigger switch ${label} moved the dialog/selector: ${JSON.stringify(frames)}`);
      const minPrompt = Math.min(frames[0].promptY, frames.at(-1).promptY) - 1;
      const maxPrompt = Math.max(frames[0].promptY, frames.at(-1).promptY) + 1;
      assert.ok(frames.every(f => f.promptY >= minPrompt && f.promptY <= maxPrompt), `Trigger switch ${label} bounced prompt content: ${JSON.stringify(frames)}`);
    }
    if (ui.case === 'scrolled') {
      await page.getByRole('radio', { name: await ui.t('scheduler.editor.fields.manually'), exact: true }).click();
      await page.getByRole('tabpanel').evaluate((panel) => {
        panel.parentElement.parentElement.scrollTop = 0;
      });
      // The scroll anchor must not leave a permanently long, empty form after
      // the user scrolls back up. Compare actual content bounds, not CSS values.
      await page.waitForFunction(() => {
        const panel = document.querySelector('[role="tabpanel"]');
        const content = panel.parentElement;
        const viewport = content.parentElement;
        const naturalBottom = panel.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top
          + parseFloat(getComputedStyle(content).paddingBottom);
        return viewport.scrollTop === 0
          && Math.abs(viewport.scrollHeight - Math.max(viewport.clientHeight, naturalBottom)) <= 1;
      });
      await ui.capture('manual-scrolled-back');
    }
  },
};
