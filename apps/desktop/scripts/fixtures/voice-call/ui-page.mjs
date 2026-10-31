import assert from 'node:assert/strict';
export default {
  name: 'voice-call',
  entry: './voice-call-fixture.tsx',
  viewport: { width: 800, height: 820 },
  real: 'CompanionVoiceToolbar, VoiceCallCard, VoiceCallTranscript, shared Popover/Collapse and theme tokens',
  notCovered: 'Live microphone, ASR, model requests, handoff execution and database persistence',
  cases: {
    default: {
      about: 'Live transcript only in the disclosure; history card appears after End',
      data: {},
    },
    narrow: {
      about: 'Call record and controls at 320 px',
      viewport: { width: 320, height: 900 },
      data: {},
    },
    wide: {
      about: 'Voice cards center in the conversation column beside a sidebar, not in the window',
      viewport: { width: 1280, height: 900 },
      data: { sidebar: true },
    },
    failed: {
      about: 'Retained failed original appears once in the unified transcript',
      data: { failed: true },
    },
    'speech-timeout': {
      about: 'Concise audio timeout feedback at 320 px',
      viewport: { width: 320, height: 900 },
      data: { mode: 'speechTimeout' },
    },
    'speech-error': {
      about:
        'Unknown read-aloud failure retains the reply without prescribing configuration changes',
      data: { mode: 'speech' },
    },
    empty: {
      about: 'Ending an empty call leaves the existing conversation without a call card',
      data: { empty: true },
    },
    elsewhere: {
      about: 'Off its task page: open-conversation entry and a question waiting off screen',
      viewport: { width: 320, height: 900 },
      data: { mode: 'elsewhere' },
    },
    muted: { about: 'Microphone-only mute retains its feedback', data: { mode: 'muted' } },
    speaking: { about: 'Speaking retains the interrupt control', data: { mode: 'speaking' } },
    countdown: {
      about: 'A narrow exit countdown keeps Cancel and End reachable',
      viewport: { width: 320, height: 900 },
      data: { mode: 'countdown' },
    },
    long: {
      about: 'Long transcript is bounded and wraps without moving the composer',
      data: { mode: 'long' },
    },
  },
  async ready(page) {
    await page.locator('.companion-voice-toolbar').waitFor();
  },
  async check(page, ui) {
    const centerX = (box) => box.x + box.width / 2;
    const assertTimelineCentered = async (selector) => {
      const timeline = await page.locator('[data-fixture-timeline]').boundingBox();
      const card = await page.locator(selector).boundingBox();
      assert.ok(
        Math.abs(centerX(card) - centerX(timeline)) < 1,
        'card centers in its conversation',
      );
      assert.ok(
        Math.abs(card.width - Math.min(580, timeline.width)) < 1,
        'card keeps its width limit',
      );
    };
    assert.equal(await page.locator('[data-voice-call-card]').count(), 0);
    assert.equal(await page.locator('.companion-voice-caption').count(), 0);
    const details = page.locator('.companion-voice-toolbar button[aria-expanded]');
    const composerBefore = await page.locator('[data-fixture-composer]').boundingBox();
    await details.click();
    const composerAfter = await page.locator('[data-fixture-composer]').boundingBox();
    assert.equal(
      composerAfter.y,
      composerBefore.y,
      'opening the transcript must not move the composer',
    );
    const barBox = await page.locator('.companion-voice-bar').boundingBox();
    const popoverBox = await page.locator('.companion-voice-details').boundingBox();
    assert.ok(
      Math.abs(centerX(barBox) - centerX(composerAfter)) < 1,
      'toolbar centers on the composer',
    );
    assert.ok(
      Math.abs(centerX(popoverBox) - centerX(barBox)) < 1,
      'popover centers on the toolbar',
    );
    assert.ok(Math.abs(popoverBox.width - barBox.width) < 1, 'popover follows the toolbar width');
    assert.ok(popoverBox.y + popoverBox.height <= barBox.y, 'transcript floats above its toolbar');
    if (ui.data.empty) {
      const emptyText = await ui.t('bots.voiceMode.transcriptEmpty');
      await page.getByText(emptyText).waitFor();
      await ui.capture('empty-live');
      await page.keyboard.press('Escape');
      await page.locator('.companion-voice-actions > button').last().click();
      assert.equal(await page.locator('.companion-voice-toolbar').count(), 0);
      assert.equal(await page.locator('[data-voice-call-card]').count(), 0);
      assert.equal(await page.getByText(emptyText).count(), 0);
      assert.equal(await page.getByText('这是通话之前的消息。').count(), 1);
      await ui.capture('empty-ended');
      return;
    }
    await page.getByText('今天想聊聊周末怎么安排。').first().waitFor();
    assert.equal(await details.getAttribute('aria-expanded'), 'true');
    const transcript = page.locator('[data-voice-call-transcript]');
    // Both current ASR and retained failure share the transcript, never a
    // second paragraph/caption. These fixture originals are not translations.
    const retained = transcript.getByText('还有一个想法，请先记下来。');
    if (await retained.count()) assert.equal(await retained.count(), 1);
    else if (ui.data.mode === 'speech' || ui.data.mode === 'speechTimeout') {
      assert.equal(
        await page.getByRole('alert').textContent(),
        await ui.t(`bots.voiceMode.errors.${ui.data.mode}`),
      );
    } else assert.equal(await transcript.getByText('听起来不错。').count(), 1);
    await ui.capture('expanded');
    if (ui.data.mode === 'long') {
      await transcript.hover();
      await page.mouse.wheel(0, -400);
      const jump = page.getByRole('button', { name: await ui.t('chat.jumpToBottom'), exact: true });
      await jump.waitFor();
      await ui.capture('reading-earlier');
      await jump.click();
      await jump.waitFor({ state: 'hidden' });
    }
    if (ui.data.mode === 'countdown') {
      await page
        .getByRole('button', { name: await ui.t('bots.voiceMode.exit.cancel'), exact: true })
        .click();
      assert.equal(await page.getByRole('timer').count(), 0);
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
    }
    if (ui.data.mode === 'muted') {
      await page
        .getByRole('button', { name: await ui.t('bots.voiceMode.unmute'), exact: true })
        .click();
      assert.equal(
        await page
          .getByRole('button', { name: await ui.t('bots.voiceMode.mute'), exact: true })
          .count(),
        1,
      );
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
    }
    if (ui.data.mode === 'speaking') {
      await page
        .getByRole('button', { name: await ui.t('bots.voiceMode.interrupt'), exact: true })
        .click();
      assert.equal(
        await page
          .getByRole('button', { name: await ui.t('bots.voiceMode.interrupt'), exact: true })
          .count(),
        0,
      );
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
    }
    await page.locator('[data-fixture-composer]').click();
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    await details.click();
    await page.keyboard.press('Escape');
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.companion-voice-toolbar').count(), 1);
    await details.click();
    await transcript.locator('button').first().click();
    assert.equal(await page.locator('[data-focused-task="true"]').count(), 1);
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    // End is the last control in the compact bar. Expansion never called it.
    await page.locator('.companion-voice-actions > button').last().click();
    await page.locator('[data-voice-call-card]').waitFor();
    const card = page.locator('[data-voice-call-card] button[aria-expanded]');
    assert.equal(await card.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-voice-call-card]').count(), 1);
    assert.equal(await page.locator('[data-voice-call-task]').count(), 1);
    await assertTimelineCentered('[data-voice-call-card]');
    await assertTimelineCentered('[data-voice-call-task]');
    await ui.capture('ended');
    await card.click();
    await page.getByText('今天想聊聊周末怎么安排。').waitFor();
    await assertTimelineCentered('[data-voice-call-card]');
    await ui.capture('history');
  },
};
