import assert from 'node:assert/strict';

export default {
  name: 'ask-user-question',
  entry: './ask-user-question-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'AskUserQuestionPrompt, voice choice draft/confirmation, CompanionVoiceToolbar, question references, prompt shell and themes',
  notCovered: 'Actual microphone/ASR/TTS, task execution, host file contents, browser navigation and remote connectivity',
  // Keep the real dictation hook/state UI; microphone capture and its worklet
  // are outside this fixture, so only the microphone and host are fake.
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export function getVoiceInputWorkletUrl() { return "/fixture-worklet.js"; }',
    'src/renderer/voice-input/captureSession': `export async function startVoiceInputCaptureSession(options) {
      options.setEngine({ drainBufferedAudio: async () => {}, stop: async () => {} });
      if (!window.__uiPage.ctx.case.endsWith('starting')) options.onCaptureReady?.();
      return { ok: true, drainPendingChunks: () => {} };
    }`,
  },
  cases: {
    'input-free': { about: 'Full-width free answer with inset voice and icon send', viewport: { width: 320, height: 620 }, data: { question: '请补充你看到的现象。', free: true } },
    'input-custom': { about: 'Full-width custom choice with inset controls', viewport: { width: 320, height: 620 }, data: { question: '你希望怎样处理？' } },
    'input-multi': { about: 'Multi-select custom answer uses one inset submit', viewport: { width: 320, height: 700 }, data: { question: '你希望保留哪些选项？', multi: true } },
    'input-plan': { about: 'Plan feedback uses a full-width input with inset send', viewport: { width: 320, height: 550 }, data: {} },
    unanswered: { about: 'Expired unanswered question remains readable once in history at 320 px', viewport: { width: 320, height: 400 }, data: { question: '是否将测试包完整安装到 Duo？' } },
    withdrawn: { about: 'Withdrawn question retains draft and offers supplemental sending at 320 px', viewport: { width: 320, height: 700 }, data: { question: '你是否已经手动重新登录？', withdrawn: true } },
    'mcp-form-error': { about: 'MCP required/length error keeps draft at 320 px', viewport: { width: 320, height: 600 }, data: { question: 'Name', form: true } },
    'mcp-form-enum': { about: 'MCP literal Other enum survives and both values reach receipt', data: { question: 'Name', form: true } },
    default: { about: 'Question with a bare HTML filename and URL', data: { question: '请查看 sidebar-layout-v1.html 后确认这版交互形态是否可以进入正式实现。也可以查看 https://example.com/prototype。' } },
    narrow: { about: 'Long references at 320 px', viewport: { width: 320, height: 600 }, data: { question: '请查看 sidebar-layout-v1.html 或 https://example.com/prototypes/a-very-long-prototype-name-before-approval 后确认。' } },
    'dictation-starting': { about: 'Answer microphone starting', data: { question: '请补充你的意见。' } },
    'dictation-listening': { about: 'Answer recording with stop action', data: { question: '请补充你的意见。' } },
    'dictation-processing': { about: 'Answer transcription pending at 320 px', viewport: { width: 320, height: 600 }, data: { question: '请补充你的意见。' } },
    'dictation-speaker-filtered': { about: 'Answer recording explains that the voiceprint filter ignored someone else, at 320 px', viewport: { width: 320, height: 600 }, data: { question: '请补充你的意见。' } },
    unresolved: { about: 'Missing and ambiguous references remain plain text', data: { question: '请查看 missing.html 和 ambiguous.html，文件尚未找到或有重名时保持普通文字。' } },
    'voice-single': { about: 'Voice choice instructions with an active listening toolbar', data: { question: '你希望采用哪种方案？', voice: true } },
    'voice-multi': { about: 'Spoken multi-selection awaits confirmation in the existing card', viewport: { width: 800, height: 700 }, data: { question: '你希望保留哪些方案？', voice: true, multi: true } },
    'voice-narrow': { about: 'Voice confirmation and toolbar at 320 px', viewport: { width: 320, height: 800 }, data: { question: '你希望保留哪些方案？', voice: true, multi: true } },
    'voice-speaker-filtered': { about: 'Call bar explains that the voiceprint filter ignored someone else', data: { question: '你希望采用哪种方案？', voice: true, speakerFiltered: true } },
  },
  async ready(page) {
    await page.locator('main').waitFor();
  },
  async check(page, ui) {
    const checkComposer = async () => {
      const frame = page.getByTestId('interaction-answer-composer');
      const field = frame.locator('textarea');
      const frameBox = await frame.boundingBox();
      const fieldBox = await field.boundingBox();
      assert.ok(fieldBox.width >= frameBox.width - 30, 'Text occupies the full input width');
      const send = frame.getByRole('button').last();
      const sendBox = await send.boundingBox();
      assert.ok(sendBox.y >= fieldBox.y + fieldBox.height - 1, 'Actions sit below the text');
      assert.ok(sendBox.x >= frameBox.x && sendBox.x + sendBox.width <= frameBox.x + frameBox.width, 'Send stays inside the frame');
      assert.equal((await send.textContent()).trim(), '', 'Send uses an icon, not a long label');
      assert.ok(await send.getAttribute('aria-label'), 'Icon keeps its accessible action name');
    };
    if (ui.case.startsWith('input-')) {
      if (ui.case === 'input-plan') await page.getByRole('button', { name: await ui.t('newChat.planReview.feedbackPlaceholder'), exact: true }).click();
      else if (ui.case !== 'input-free') {
        if (ui.case === 'input-multi') await page.getByText('可以，按这版实现', { exact: true }).click();
        await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.customAnswer') }).click();
      }
      await page.locator('textarea').fill('已重新登录，另补充一个现象。\n这里应该有充足的文字输入空间。');
      await checkComposer();
      return;
    }
    if (ui.case === 'unanswered') {
      await page.getByText(await ui.t('chat.askUserQuestion.unanswered'), { exact: true }).waitFor();
      assert.equal(await page.getByText('是否将测试包完整安装到 Duo？', { exact: true }).count(), 1);
      assert.equal(await page.getByText('✓', { exact: true }).count(), 0);
      return;
    }
    if (ui.case === 'withdrawn') {
      await page.getByRole('status').waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.skip'), exact: true }).count(), 0);
      const input = page.getByPlaceholder(await ui.t('chat.askUserQuestion.answerPlaceholder'));
      await input.fill('已重新登录，另补充一个现象。');
      assert.equal(await input.inputValue(), '已重新登录，另补充一个现象。');
      await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.sendSupplement'), exact: true }).waitFor();
      await checkComposer();
      return;
    }
    if (ui.case.startsWith('mcp-form-')) {
      await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.skip'), exact: true }).click();
      await page.getByRole('alert').waitFor();
      const input = page.getByPlaceholder(await ui.t('chat.askUserQuestion.answerPlaceholder'));
      await input.fill('ab');
      await input.press('Enter');
      assert.equal(await input.inputValue(), 'ab');
      assert.equal(await page.getByTestId('mcp-form-receipt').count(), 0);
      if (ui.case === 'mcp-form-error') return;
      await input.fill('Orbit');
      await input.press('Enter');
      await page.getByText('Other', { exact: true }).waitFor();
      assert.equal(await page.getByText(await ui.t('chat.askUserQuestion.customAnswer'), { exact: true }).count(), 0);
      await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.skip'), exact: true }).click();
      await page.getByRole('alert').waitFor();
      await page.getByText('Other', { exact: true }).click();
      await page.getByTestId('mcp-form-receipt').waitFor();
      assert.deepEqual(JSON.parse(await page.getByTestId('mcp-form-receipt').textContent()), { name: 'Orbit', kind: 'Other' });
      return;
    }
    if (ui.case.startsWith('dictation-')) {
      const mic = page.getByTestId('ask-user-voice');
      await mic.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="ask-user-voice"]')?.getAttribute('aria-pressed') === 'true');
      if (ui.case !== 'dictation-starting') {
        await page.waitForFunction(() => document.querySelector('[data-testid="ask-user-voice"]')?.getAttribute('aria-busy') === 'false');
        await page.evaluate(() => window.__uiPage.emit('voice', {
          type: 'draft', runId: 'fixture-voice', text: '建议保留原来的内容，并把语音录入的状态提示做得更清楚。', source: 'partial',
        }));
      }
      if (ui.case === 'dictation-processing') await mic.click();
      if (ui.case === 'dictation-speaker-filtered') {
        await page.evaluate(() => window.__uiPage.emit('voice', { type: 'speaker-filtered', runId: 'fixture-voice' }));
        await page.getByText(await ui.t('voiceInputOverlay.speakerFiltered')).waitFor();
      }
      const recording = ui.case === 'dictation-listening' || ui.case === 'dictation-speaker-filtered';
      assert.equal(await mic.getAttribute('aria-busy'), recording ? 'false' : 'true');
      assert.equal(await mic.isDisabled(), ui.case === 'dictation-processing');
      return;
    }
    const readVoiceFrame = () => page.getByTestId('ask-user-voice').evaluate((node) => ({
      radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    }));
    if (ui.case.startsWith('voice-')) {
      assert.equal(await page.locator('.companion-voice-toolbar').count(), 1);
      assert.equal(await page.getByText(await ui.t('voiceInputOverlay.speakerFiltered')).count(),
        ui.case === 'voice-speaker-filtered' ? 1 : 0);
      assert.ok(await page.getByRole('status').count() >= 2);
      assert.equal(await page.getByTestId('ask-user-voice').count(), 0);
      return;
    }
    const voiceFrame = await readVoiceFrame();
    assert.equal(voiceFrame.width, voiceFrame.height);
    assert.ok(voiceFrame.radius >= voiceFrame.height / 2);
    // The free-text badge stays in the option badges' column; the mic sits before it.
    const optionBadgeRight = await page.getByRole('button', { name: /可以，按这版实现/ })
      .evaluate((node) => node.lastElementChild.getBoundingClientRect().right);
    const customBadge = await page.getByTestId('ask-user-custom-badge').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    const voiceRight = await page.getByTestId('ask-user-voice').evaluate((node) => node.getBoundingClientRect().right);
    assert.ok(Math.abs(customBadge.right - optionBadgeRight) < 0.5, `badge column ${customBadge.right} vs ${optionBadgeRight}`);
    assert.ok(voiceRight <= customBadge.left, 'Microphone sits before the free-text badge');
    if (ui.case !== 'unresolved') await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).waitFor();
    assert.equal(await page.getByRole('link').count(), ui.case === 'unresolved' ? 0 : 2);
    if (ui.case !== 'unresolved') {
      assert.equal(await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline');
    }
    await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.customAnswer') }).click();
    const expandedFrame = await readVoiceFrame();
    assert.equal(expandedFrame.width, 32);
    assert.equal(expandedFrame.height, 32);
    assert.ok(expandedFrame.radius >= 16, 'Expanded microphone action frame follows the same pill tier');
  },
};
