import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

export default {
  ...group,
  name: 'group-jump-bottom',
  entry: '../group-control/group-control-fixture.tsx',
  stubs: {
    ...group.stubs,
    // Unrelated ?url asset imports are unsupported by the single-page builder.
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview': 'export const DrawioPreview = () => null;',
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview': 'export const PdfPreview = () => null;',
  },
  notCovered: 'PDF/Drawio previews and real network; actual group layout and native input use synthetic host data. Short-main read checks supply a focused-host signal to the hidden Electron window.',
  cases: {
    'short-main-follow': { about: 'Upward input in a fitting main chat preserves follow when content grows',
      data: { ...group.cases['process-history'].data, processDisclosure: true, shortUpGrowth: true } },
    'short-topic-follow': { about: 'Upward input in a fitting topic preserves follow when content grows',
      data: { ...group.cases['process-history'].data, processDisclosure: true, shortUpGrowth: true, threadPanel: true } },
    'short-main-read': { about: 'Explicit End/wheel return acknowledges an inspected main chat even when it fits without scrolling',
      data: { ...group.cases['process-history'].data, shortMainRead: true } },
    'thread-process': { about: 'A process in the actual topic sidebar uses the same stable disclosure behavior as the main group',
      data: { ...group.cases['process-history'].data, processDisclosure: true, threadPanel: true } },
    'live-process': { about: 'Running process disclosure keeps its heading still through each animation frame',
      data: { ...group.cases['work-thinking'].data, sidebar: false, messages: 40, processDisclosure: true } },
    'history-process': { about: 'Historical process disclosure keeps the reading position and allows returning to live follow',
      data: { ...group.cases['process-history'].data, processDisclosure: true } },
    'short-growth': { about: 'A located short chat keeps its reading position and reveals unread navigation when content grows',
      data: { ...group.cases['long-thread'].data, messages: 2, sidebar: false, shortGrowth: true, controlled: true } },
    default: { about: 'History navigation temporarily replaces topic hints without changing scroll geometry',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true } },
    'with-control': { about: 'Navigation replaces both topic and connection bubbles; idle/return restores them unchanged',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true, controlled: true } },
  },
  async ready(page) {
    await group.ready(page);
    if (await page.evaluate(() => window.__uiPage.ctx.data.controlled)) {
      await page.evaluate(() => window.__uiPage.emit('controlledState', {
        controllers: [{ deviceId: 'fixture', name: 'Mac Studio' }],
      }));
      await page.locator('[data-controlled-banner-chip]').waitFor();
    }
  },
  async check(page, ui) {
    if (ui.data.shortMainRead) return checkShortMainRead(page, ui);
    if (ui.data.processDisclosure) return checkProcessDisclosure(page, ui);
    const timeline = page.getByTestId('bot-group-timeline');
    const composer = page.locator('[data-chat-composer-stack]');
    const bubbles = page.locator('[data-group-bottom-bubbles]');
    const hint = page.locator('[data-thread-hint]');
    const banner = page.locator('[data-controlled-banner-chip]');
    if (ui.data.shortGrowth) {
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.serverBacked = true;
        group.messages = group.messages.map((message, index) => index === 1 ? { ...message,
          quote: { messageId: 'm0', authorName: 'You', authorKind: 'user', excerpt: 'Layout message 1',
            attachmentCount: 0, attachmentName: null, sequence: 1 },
        } : message);
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByTestId('bot-group-quote').click();
      assert.equal(await timeline.evaluate(el => el.scrollHeight - el.clientHeight), 0, 'located chat initially fits');
      await page.evaluate(async () => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.messages = [...group.messages, { ...group.messages[0], id: 'new-reply', sequence: 3,
          authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', content: 'New reply after locating',
          createdAt: Date.now() }];
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      });
      await page.getByText('New reply after locating', { exact: true }).waitFor();
      await page.locator('[data-bot-group-message-id="new-reply"]').evaluate(el => { el.style.minHeight = '1000px'; });
      await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
      assert.equal(await timeline.evaluate(el => el.scrollTop), 0, 'content growth must preserve the historical position');
      const unread = page.getByRole('button', { name: await ui.t('chat.newMessageIndicator.aria', { count: 1 }), exact: true });
      assert.equal(await unread.evaluate(el => el.parentElement.classList.contains('opacity-100')), true);
      await ui.capture('short-group-unread');
      await unread.click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="bot-group-timeline"]');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      });
      await page.waitForFunction(() => !document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
      await ui.capture('short-group-returned');
      return;
    }
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el && el.scrollHeight > el.clientHeight && el.scrollTop > 0;
    });
    const initialTimeline = await timeline.boundingBox();
    const initialComposer = await composer.boundingBox();
    const sameGeometry = async () => {
      assert.deepEqual(await timeline.boundingBox(), initialTimeline, 'navigation must not resize the timeline');
      assert.deepEqual(await composer.boundingBox(), initialComposer, 'navigation must not move the composer');
    };
    await page.mouse.move(initialTimeline.x + 24, initialTimeline.y + initialTimeline.height / 2);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight > 500;
    });
    await page.getByTestId('group-attention-hint').click();
    await page.getByRole('dialog').waitFor();
    await page.mouse.move(initialTimeline.x + 24, initialTimeline.y + initialTimeline.height / 2);
    await page.mouse.wheel(0, 150);
    const jump = page.getByRole('button', { name: await ui.t('chat.jumpToBottom'), exact: true });
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    assert.equal(await page.getByRole('dialog').count(), 0, 'open topic portal also yields to navigation');
    assert.equal(await hint.isVisible(), false, 'topic yields to navigation');
    if (ui.data.controlled) assert.equal(await banner.isVisible(), false, 'connection bubble also yields');
    assert.equal(await bubbles.getAttribute('inert'), '', 'hidden bubble actions cannot receive input');
    await sameGeometry();
    await ui.capture('navigation-replaces-bubbles');
    await hint.waitFor({ state: 'visible', timeout: 3500 });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns on idle');
    await sameGeometry();
    await ui.capture('bubbles-restored-after-idle');
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    await jump.click();
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = '500px'; });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    });
    await hint.waitFor({ state: 'visible' });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns at the tail');
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = ''; });
    await sameGeometry();
    await ui.capture('returned-to-bottom');
  },
};

// Regression: the actual group timeline used to pin to bottom on every disclosure
// resize (109px live / 156px history). Sample animation frames, not just endpoints.
async function checkProcessDisclosure(page, ui) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  let surface = page;
  const preview = {
    content: '| ' + Array.from({ length: 10 }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |\n| ' + Array(10).fill('---').join(' | ') + ' |\n| ' + Array(10).fill('wide_table_content').join(' | ') + ' |\n\n```mermaid\ngraph LR; A-->B\n```',
    attachments: [{ id: 'wheel-preview', name: 'wheel-preview.png', category: 'image', mimeType: 'image/png', size: 68,
      path: null, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }],
  };
  if (ui.data.threadPanel) {
    await page.evaluate(async preview => {
      const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
      const count = window.__uiPage.ctx.data.shortUpGrowth ? 1 : 30;
      const answer = { ...group.messages[0], replyCount: count };
      group.messages = [answer];
      const replies = Array.from({ length: count }, (_, i) => ({ ...answer, id: `reply-${i}`,
        threadRootId: answer.id, sequence: i + 2, content: `Reply ${i + 1}`,
        process: i === count - 1 ? answer.process : undefined, ...(i === 28 ? { ...preview, authorKind: 'user', isSelf: true } : {}) }));
      window.__uiPage.threadReads = [];
      window.electronAPI.maker.chatServer.thread = async input => {
        window.__uiPage.threadReads.push(input.markRead);
        return { ok: true, root: { ...answer, process: undefined }, replies: [...replies], hasMore: false };
      };
      window.electronAPI.maker.chatServer.reply = async input => {
        replies.push({ ...answer, id: 'sent-reply', clientId: input.clientId,
          threadRootId: answer.id, sequence: 32, authorKind: 'user', authorBotId: null,
          isSelf: true, content: input.text, process: undefined });
        return { ok: true, messageId: 'sent-reply' };
      };
      window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
    }, preview);
    await page.locator('[data-thread-preview]').first().click();
    surface = page.locator('aside.thread-panel');
  }
  const heading = surface.locator('[data-teammate-process] > button').last();
  await heading.waitFor();
  if (ui.data.shortUpGrowth) {
    const timeline = ui.data.threadPanel ? surface.locator('div.overflow-y-auto').first() : page.getByTestId('bot-group-timeline');
    return checkShortUpGrowth(page, ui, timeline, heading);
  }
  if (ui.data.processRecord && !ui.data.threadPanel) {
    await page.evaluate(async preview => {
      const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
      const answer = group.messages[0];
      group.messages = [...Array.from({ length: 30 }, (_, i) => ({ ...answer,
        id: `history-${i}`, sequence: i + 1, content: `Checked record ${i + 1}`, process: undefined,
        ...(i === 29 ? { ...preview, authorKind: 'user', isSelf: true } : {}),
      })), { ...answer, sequence: 31 }];
      window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
    }, preview);
    await page.locator('[data-bot-group-message-id="history-29"]').waitFor();
  } else if (!ui.data.processRecord) {
    assert.equal(await page.locator('[data-teammate-process]').last().locator('.animate-spinner').count(), 1,
      'the header already communicates working; no extra loading row after notes');
  }
  const timeline = ui.data.threadPanel ? surface.locator('div.overflow-y-auto').first() : page.getByTestId('bot-group-timeline');
  await timeline.evaluate(el => { el.dataset.processScrollCheck = ''; });
  await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-process-scroll-check]');
    return el.scrollHeight > el.clientHeight && Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 2;
  });
  if (ui.data.processRecord || ui.data.threadPanel) {
    const image = surface.getByRole('button', { name: 'wheel-preview.png', exact: true });
    const diagram = surface.getByRole('button', { name: await ui.t('chat.mermaid.clickToZoom'), exact: true });
    // Keep fixture thumbnails compact so real pointer input can open them next to
    // the inspected heading without scrolling the underlying list first.
    await image.evaluate(el => { el.style.height = '32px'; el.style.width = '32px'; });
    await diagram.evaluate(el => { el.style.maxHeight = '32px'; el.style.overflow = 'hidden'; });
  }
  const composerElement = ui.data.threadPanel ? surface.locator('textarea') : surface.locator('[data-chat-composer-stack]');
  const composer = await composerElement.boundingBox();
  for (let cycle = 0; cycle < 4; cycle++) {
    await heading.evaluate(button => {
      window.disclosureFrames = new Promise(resolve => button.addEventListener('click', () => {
        const start = performance.now(), positions = [button.getBoundingClientRect().y];
        const tick = () => {
          positions.push(button.getBoundingClientRect().y);
          if (performance.now() - start < 650) requestAnimationFrame(tick);
          else resolve(positions);
        };
        requestAnimationFrame(tick);
      }, { once: true }));
    });
    if (cycle < 2) await heading.click();
    else { await heading.focus(); await heading.press('Enter'); }
    const positions = await page.evaluate(() => window.disclosureFrames);
    const drift = Math.max(...positions) - Math.min(...positions);
    assert.ok(drift <= 1, `process heading moved ${drift}px during toggle ${cycle}`);
    assert.deepEqual(await composerElement.boundingBox(), composer);
    await ui.capture(`process-toggle-${cycle}`);
  }
  if (ui.data.processRecord || ui.data.threadPanel) {
    for (const kind of ['image', 'diagram']) {
      const trigger = surface.getByRole('button', { name: kind === 'image' ? 'wheel-preview.png' : await ui.t('chat.mermaid.clickToZoom'), exact: true });
      const before = await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight }));
      assert.ok(before.reserve, 'preview starts during process inspection');
      await trigger.click();
      const overlay = page.locator('[data-lightbox-layer]');
      await overlay.waitFor();
      const bounds = await overlay.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 120);
      await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
      assert.deepEqual(await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight })), before,
        `${kind} preview wheel must not resume the background list`);
      await overlay.press('End');
      assert.deepEqual(await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight })), before,
        `${kind} preview End must not resume the background list`);
      await ui.capture(`preview-${kind}-preserves-inspection`);
      await overlay.getByRole('button', { name: await ui.t('chat.lightbox.close'), exact: true }).click();
      await overlay.waitFor({ state: 'detached' });
    }
  }
  const reserve = await timeline.evaluate(el => parseFloat(el.firstElementChild.style.minHeight));
  const box = await timeline.boundingBox();
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(oldReserve => {
    const content = document.querySelector('[data-process-scroll-check]').firstElementChild;
    return parseFloat(content.style.minHeight) < oldReserve;
  }, reserve);
  await page.mouse.wheel(0, 8000);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-process-scroll-check]');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2 && !el.firstElementChild.style.minHeight;
  });
  // A subsequent real layout change must follow the tail again.
  await timeline.evaluate(el => {
    el.querySelector('article:last-of-type').style.minHeight = '500px';
    // Deliver the previous scroll notification before ResizeObserver, as can
    // happen when sending while the process is still animating open.
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-process-scroll-check]');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  await ui.capture('process-follow-restored');
  if (ui.data.threadPanel) {
    await heading.click();
    const reads = await page.evaluate(() => window.__uiPage.threadReads.length);
    await page.evaluate(() => window.__uiPage.emit('botGroupChanged', { groupId: 'fixture-group', change: 'messages' }));
    await page.waitForFunction(count => window.__uiPage.threadReads.length > count, reads);
    assert.equal(await page.evaluate(() => window.__uiPage.threadReads.at(-1)), false, 'inspection must not acknowledge incoming replies');
    const beforeEnd = await page.evaluate(() => window.__uiPage.threadReads.length);
    await timeline.evaluate(el => { el.tabIndex = -1; el.focus({ preventScroll: true }); });
    await timeline.press('End');
    await page.waitForFunction(count => window.__uiPage.threadReads.length > count, beforeEnd);
    assert.equal(await page.evaluate(() => window.__uiPage.threadReads.at(-1)),
      await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible'),
      'explicit return uses the normal visibility/focus read guard');
    await heading.click();
    const input = surface.locator('textarea');
    await input.fill('Continue after inspecting the process');
    await input.press('Enter');
    await surface.locator('[data-bot-group-message-id="sent-reply"]').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-process-scroll-check]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2 && !el.firstElementChild.style.minHeight;
    });
    await ui.capture('thread-send-restores-follow');
  }
  // Real pointer press on root padding may end inside the list or over the
  // sibling composer; either stationary gesture only pauses follow temporarily.
  for (const release of ['inside', 'composer']) {
    await page.mouse.move(box.x + (ui.data.threadPanel ? 12 : 2), box.y + box.height / 2);
    await page.mouse.down();
    if (release === 'composer') {
      const composerBox = await composerElement.boundingBox();
      await page.mouse.move(composerBox.x + composerBox.width / 2, composerBox.y + composerBox.height / 2);
    }
    await page.mouse.up();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await timeline.evaluate(el => {
      const last = el.querySelector('article:last-of-type');
      last.style.minHeight = `${last.getBoundingClientRect().height + 120}px`;
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-process-scroll-check]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    });
    await ui.capture(`stationary-pointer-${release}-keeps-follow`);
  }
  if (ui.data.processRecord || ui.data.threadPanel) {
    const table = surface.locator('table').last();
    // Position the actual table next to the inspected process without changing
    // its normal overflowing table wrapper or dispatching a synthetic wheel.
    await table.evaluate(el => { el.style.minWidth = '1400px'; el.parentElement.style.height = '50px'; el.parentElement.style.overflowY = 'hidden'; });
    await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await heading.click();
    await page.waitForFunction(() => !!document.querySelector('[data-process-scroll-check]').firstElementChild.style.minHeight);
    const before = await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight }));
    // Send actual Chromium wheel input with zoom modifiers through the real
    // main/topic handlers; zoom must not release the reserved reading position.
    for (const modifier of ['Control', 'Meta']) {
      await page.evaluate(() => {
        window.__uiPage.zoomWheelReceived = false;
        // React's root handler runs before this document bubble listener. Only
        // the fixture cancels the browser's default scroll/zoom afterwards, so
        // the position assertion measures the product handler's own mutations.
        document.addEventListener('wheel', event => {
          window.__uiPage.zoomWheelReceived = event.ctrlKey || event.metaKey;
          event.preventDefault();
        }, { once: true, passive: false });
      });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down(modifier);
      try { await page.mouse.wheel(0, 80); }
      finally { await page.keyboard.up(modifier); }
      await page.waitForFunction(() => window.__uiPage.zoomWheelReceived);
      assert.deepEqual(await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight })), before,
        `${modifier} wheel must preserve process inspection`);
    }
    await ui.capture('zoom-wheel-keeps-inspection');
    const tableBox = await table.boundingBox();
    assert.ok(tableBox && tableBox.y > box.y && tableBox.y < box.y + box.height, 'actual table is visible for wheel input');
    await page.mouse.move(Math.max(tableBox.x, box.x) + 30, tableBox.y + 20);
    await page.mouse.wheel(80, 1);
    await page.waitForFunction(() => document.querySelector('[data-process-scroll-check] table').parentElement.scrollLeft > 0);
    assert.deepEqual(await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight })), before,
      'horizontal table wheel must preserve process inspection');
    await ui.capture('horizontal-table-keeps-inspection');
    await timeline.evaluate(el => { el.tabIndex = -1; el.focus({ preventScroll: true }); });
    await timeline.press('End');
  }
  // Deliver the native scroll input boundary in the problematic order: layout
  // already moved the real range by 10px, click enters inspection, then the old
  // notification arrives. jsdom alone cannot run the actual resize/animation.
  const inspected = await timeline.evaluate(el => {
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    const last = el.querySelector('article:last-of-type');
    last.style.minHeight = `${last.getBoundingClientRect().height + 10}px`;
    el.scrollTop = el.scrollHeight;
    el.querySelector('[data-teammate-process] > button').click();
    const position = { top: el.scrollTop, reserve: el.firstElementChild.style.minHeight };
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return position;
  });
  assert.ok(inspected.reserve, 'inspection starts with a reserved range');
  await page.evaluate(async () => { for (let i = 0; i < 24; i++) await new Promise(requestAnimationFrame); });
  assert.deepEqual(await timeline.evaluate(el => ({ top: el.scrollTop, reserve: el.firstElementChild.style.minHeight })), inspected,
    'queued auto-follow notification must preserve inspection through real layout');
  await ui.capture('queued-scroll-keeps-inspection');
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-process-scroll-check]');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2 && !el.firstElementChild.style.minHeight;
  });
  // Native keys act while the content changes in the same input turn. A later
  // ResizeObserver must respect the reader; wheel navigation then returns to the tail.
  for (const key of ['PageUp', 'Home']) {
    await timeline.evaluate(el => {
      el.tabIndex = -1; el.focus({ preventScroll: true });
      el.addEventListener('keydown', () => {
        const last = el.querySelector('article:last-of-type');
        last.style.minHeight = `${last.getBoundingClientRect().height + 120}px`;
      }, { once: true });
    });
    await timeline.press(key);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-process-scroll-check]');
      return el.scrollHeight - el.scrollTop - el.clientHeight > 200;
    });
    await assertBrowsingSurvivesResize(timeline);
    await ui.capture(`growth-${key}`);
    await timeline.evaluate(el => {
      window.lastNavigationWheel = null;
      el.addEventListener('wheel', event => {
        window.lastNavigationWheel = { deltaY: event.deltaY, target: event.target.outerHTML.slice(0, 160),
          top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
      }, { once: true, capture: true });
    });
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-process-scroll-check]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    }).catch(async error => {
      const state = await timeline.evaluate(el => ({ wheel: window.lastNavigationWheel,
        top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }));
      throw new Error(`${key} wheel reset failed: ${JSON.stringify(state)}; ${error.message}`);
    });
  }
  // Drive the scrollbar input boundary against the real native scroll range;
  // jsdom cannot execute the observer that used to pull this move back down.
  await timeline.evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const last = el.querySelector('article:last-of-type');
    last.style.minHeight = `${last.getBoundingClientRect().height + 120}px`;
    el.scrollTop -= 400;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await assertBrowsingSurvivesResize(timeline);
  await ui.capture('growth-scrollbar-input');
}

async function assertBrowsingSurvivesResize(timeline) {
  const away = await timeline.evaluate(async el => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
  assert.ok(away > 200, `content resize overrode manual browsing (${away}px from tail)`);
}

// PR #9249 r4500734691: real production handlers and native zero-range input.
// The UI runner is hidden; focus and server receipts are explicit host fixtures.
async function checkShortMainRead(page, ui) {
  const timeline = page.getByTestId('bot-group-timeline');
  const heading = page.locator('[data-teammate-process] > button').last();
  await heading.waitFor();
  await page.evaluate(() => {
    window.__uiPage.originalHasFocus = document.hasFocus;
    document.hasFocus = () => true;
    window.__uiPage.mainReads = [];
    window.electronAPI.maker.chatServer.manage = async input => {
      window.__uiPage.mainReads.push(input);
      return { ok: true };
    };
  });
  try {
    for (const action of ['End', 'wheel']) {
      await heading.click();
      await page.evaluate(async action => {
        const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
        group.messages = [...group.messages, { ...group.messages[0], id: `short-${action}`, sequence: group.messages.length + 1,
          content: `Short unread reply ${action}`, process: undefined, createdAt: Date.now() }];
        group.serverUnread = { count: 1, mentioned: false };
        window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
      }, action);
      await page.getByText(`Short unread reply ${action}`, { exact: true }).waitFor();
      const before = await page.evaluate(() => window.__uiPage.mainReads.length);
      assert.equal(before, action === 'End' ? 0 : 1, 'inspection must preserve unread replies');
      assert.equal(await timeline.evaluate(el => el.scrollHeight - el.clientHeight), 0, 'reply still fits the viewport');
      await timeline.evaluate(el => {
        window.__uiPage.mainScrollEvents = 0;
        el.addEventListener('scroll', () => { window.__uiPage.mainScrollEvents++; });
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      });
      if (action === 'End') await timeline.press('End');
      else {
        const box = await timeline.boundingBox();
        await page.mouse.move(box.x + 24, box.y + box.height / 2);
        await page.mouse.wheel(0, 80);
      }
      await page.waitForFunction(count => window.__uiPage.mainReads.length === count + 1, before);
      assert.deepEqual(await page.evaluate(() => window.__uiPage.mainReads.at(-1)),
        { groupId: 'fixture-group', action: { type: 'read', messageId: `short-${action}` } });
      assert.equal(await timeline.evaluate(el => el.scrollTop), 0, 'explicit return has no displacement');
      assert.equal(await page.evaluate(() => window.__uiPage.mainScrollEvents), 0, 'no scroll notice can acknowledge for us');
      await timeline.press('End');
      await page.mouse.wheel(0, 80);
      assert.equal(await page.evaluate(() => window.__uiPage.mainReads.length), before + 1, 'unchanged follow does not repeat the read');
      await ui.capture(`short-main-read-${action}`);
    }
  } finally {
    await page.evaluate(() => { document.hasFocus = window.__uiPage.originalHasFocus; });
  }
}

// PR #9249 r4500848903: real range and ResizeObserver, without a scroll event
// for the original upward input. Existing growth cases begin with a long list.
async function checkShortUpGrowth(page, ui, timeline, heading) {
  await timeline.evaluate(el => { el.dataset.shortFollowCheck = ''; });
  const resetShort = async () => {
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = ''; });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-short-follow-check]');
      return el.scrollHeight === el.clientHeight && el.scrollTop === 0;
    });
  };
  for (const action of ['wheel', 'PageUp']) {
    await resetShort();
    await timeline.evaluate((el, action) => {
      el.tabIndex = -1; el.focus({ preventScroll: true });
      window.__uiPage.shortUpReceived = false;
      el.addEventListener(action === 'wheel' ? 'wheel' : 'keydown', () => { window.__uiPage.shortUpReceived = true; }, { once: true });
    }, action);
    if (action === 'PageUp') await timeline.press(action);
    else {
      const box = await timeline.boundingBox();
      await page.mouse.move(box.x + 24, box.y + box.height / 2);
      await page.mouse.wheel(0, -80);
    }
    await page.waitForFunction(() => window.__uiPage.shortUpReceived);
    assert.equal(await timeline.evaluate(el => el.scrollTop), 0, 'upward input has no displacement');
    await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = '1000px'; });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-short-follow-check]');
      return el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    });
    await ui.capture(`short-follow-after-${action}`);
  }
  await resetShort();
  await heading.click();
  await timeline.evaluate(el => { el.querySelector('article:last-of-type').style.minHeight = '1000px'; });
  await page.evaluate(async () => { for (let i = 0; i < 24; i++) await new Promise(requestAnimationFrame); });
  assert.equal(await timeline.evaluate(el => el.scrollTop), 0, 'explicit short-list process inspection must still suppress following');
  await ui.capture('short-inspection-preserved');
}
