import assert from 'node:assert/strict';

export async function checkSplit(page, ui) {
  const timeline = page.getByTestId('bot-group-timeline');
  const main = timeline.locator('..');
  const row = timeline.locator('[data-bot-group-message-id="width-bot"]');
  await page.evaluate(async () => {
    const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
    group.messages = group.messages.map((message, i) => ({ ...message, reactions: [], content: i ? [
      '今天发布前需要确认这几件事：',
      '1. **主界面与气泡宽度**：群聊和私聊使用同样的阅读宽度。打开话题后，两边正文随各自的可用空间调整。',
      '2. **分栏极值**：侧栏展开时，把话题拖到最宽和最窄，长消息仍然可以阅读，操作按钮不会遮住正文。',
      '3. **复杂内容**：长链接、代码、表格和长文件名保持在当前消息区域内，表格最后一列可以通过内部滚动查看。',
      '4. **输入与草稿**：主群和话题分别输入多行内容，拖拽、收起侧栏、关闭重开话题之后，两份草稿都应保留。',
      '以上检查分别覆盖亮色和暗色；每个发现的问题修正后，再重新检查对应场景。',
    ].join('\n\n') : '请整理发布前的检查清单。' }));
    window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
  });
  await row.getByText('今天发布前需要确认这几件事：', { exact: true }).waitFor();
  await row.hover();
  await row.getByRole('button', { name: await ui.t('bots.groupChat.server.startTopic'), exact: true }).click();
  const panel = page.locator('.thread-panel');
  const handle = panel.getByRole('separator');
  await panel.locator('textarea').waitFor();
  // A clean reading state as well as the intentionally large drafts below.
  const initialHandle = await handle.boundingBox();
  await page.mouse.move(initialHandle.x + 4, initialHandle.y + 100);
  await page.mouse.down();
  await page.mouse.move(0, initialHandle.y + 100, { steps: 12 });
  await page.mouse.up();
  await row.scrollIntoViewIfNeeded();
  await ui.capture('reading-at-limit');
  const mainDraft = '主群草稿保持不变。'.repeat(20);
  const replyDraft = '话题草稿保持不变。'.repeat(20);
  await main.locator('textarea').fill(mainDraft);
  await panel.locator('textarea').fill(replyDraft);
  const drag = async direction => {
    const r = await handle.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + 100);
    await page.mouse.down();
    await page.mouse.move(direction === 'wide' ? 0 : ui.viewport.width - 1, r.y + 100, { steps: 12 });
    await page.mouse.up();
  };
  const check = async label => {
    await page.evaluate(() => { delete window.__widthSample; });
    await page.waitForFunction(() => {
      const main = document.querySelector('[data-testid="bot-group-timeline"]').closest('main');
      const width = main.getBoundingClientRect().width;
      const column = main.querySelector('[data-testid="bot-group-timeline"]').firstElementChild.getBoundingClientRect().width;
      const sample = `${width}:${column}`;
      const stable = window.__widthSample === sample;
      window.__widthSample = sample;
      return stable && Math.abs(column - Math.min(914, width - (width < 700 ? 40 : 100))) < 1;
    });
    const result = await page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="bot-group-timeline"]');
      const main = timeline.closest('main'), panel = document.querySelector('.thread-panel');
      const bubble = timeline.querySelector('[data-testid="bot-group-bubble"]');
      const column = timeline.firstElementChild;
      const b = bubble.getBoundingClientRect(), c = column.getBoundingClientRect();
      return { main: main.clientWidth, panel: panel.clientWidth, bubble: b.width, column: c.width,
        overflow: [main, timeline, panel].map(el => el.scrollWidth - el.clientWidth),
        inputs: [...document.querySelectorAll('textarea')].map(el => {
          const owner = el.closest('.thread-panel') ?? main;
          const r = el.getBoundingClientRect(), o = owner.getBoundingClientRect();
          return r.left >= o.left && r.right <= o.right && r.bottom <= o.bottom;
        }),
        actionsInside: [...document.querySelectorAll('.chat-bubble-toolbar')].every(el => {
          const owner = el.closest('.thread-panel') ?? main;
          const r = el.getBoundingClientRect(), o = owner.getBoundingClientRect();
          return r.left >= o.left && r.right <= o.right;
        }),
      };
    });
    await ui.capture(label);
    assert.ok(result.overflow.every(v => v <= 1), `${label}: no pane overflow ${JSON.stringify(result)}`);
    assert.ok(result.inputs.every(Boolean), `${label}: both inputs inside their pane`);
    assert.ok(result.actionsInside, `${label}: message controls remain reachable`);
    if (result.column - 38 <= 480) assert.ok(result.bubble >= result.column - 39,
      `${label}: narrow reply must use the column, not reserve an empty action gutter: ${JSON.stringify(result)}`);
    assert.equal(await main.locator('textarea').inputValue(), mainDraft);
    assert.equal(await panel.locator('textarea').inputValue(), replyDraft);
  };
  await drag('wide');
  await check('topic-max');
  await drag('narrow');
  await check('topic-min');
  await handle.focus();
  const before = await panel.evaluate(el => el.getBoundingClientRect().width);
  await handle.press('ArrowLeft');
  const after = await panel.evaluate(el => el.getBoundingClientRect().width);
  assert.ok(after >= before && after <= before + 17, 'keyboard resize stays bounded');
  await check('keyboard');
  // Collapse and restore the real sidebar allocation while the chosen split stays mounted.
  const sidebar = page.locator('[data-ui-frame="sidebar"]');
  if (await sidebar.count()) {
    await sidebar.evaluate(el => { el.style.display = 'none'; });
    await check('sidebar-collapsed');
    await sidebar.evaluate(el => { el.style.display = ''; });
  }
  await panel.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await main.locator('textarea').inputValue(), mainDraft);
  await ui.capture('closed');

  // Reopen after replacing the fixture content, exercising real Markdown and file chips.
  await page.evaluate(async () => {
    const { group } = await window.electronAPI.maker.getBotGroup('fixture-group');
    group.messages = group.messages.map((message, i) => ({ ...message, reactions: [],
      content: i ? [
        '评审清单：\n1. 主群与话题可以分别阅读。\n2. 草稿在缩放后保留。',
        `长链接：https://example.test/${'long-path-'.repeat(30)}`,
        '```javascript\nconst identifier = "' + 'unbroken_identifier_'.repeat(35) + '";\n```',
        '| 日期 | 版本 | 域名 | 备注 |\n| --- | --- | --- | --- |\n| 2026-11-05 | release-candidate-123456 | https://example.test/docs | 长列保留内部滚动 |',
      ].join('\n\n') : '收到',
      attachments: i ? [{ id: 'width-file', name: '超长文件名-'.repeat(20) + '.pdf', category: 'pdf', mimeType: 'application/pdf', size: 20480, url: null, path: null }] : [],
    }));
    window.__uiPage.emit('botGroupChanged', { groupId: group.id, change: 'messages' });
  });
  await row.locator('table').waitFor();
  await row.hover();
  await row.getByRole('button', { name: await ui.t('bots.groupChat.server.startTopic'), exact: true }).click();
  await panel.locator('table').waitFor();
  await drag('wide');
  await ui.emit('controlledState', { controllers: [{ deviceId: 'fixture', name: '用于极值检查的很长设备名称 Mac Studio' }] });
  await check('rich-content');
  for (const owner of [main, panel]) {
    const table = owner.locator('table');
    assert.ok(await table.evaluate(el => {
      const scroll = el.parentElement;
      scroll.scrollLeft = scroll.scrollWidth;
      const end = el.querySelector('tr:last-child td:last-child').getBoundingClientRect();
      return end.right <= scroll.getBoundingClientRect().right + 1;
    }), 'last table column is reachable in its own scroller');
    const more = owner.getByRole('button', { name: await ui.t('bots.groupChat.composer.more'), exact: true });
    await more.click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.ok(await menu.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }), 'composer menu stays within the window');
    await page.keyboard.press('Escape');
  }
  // Resize the existing window, not a disconnected sample column.
  await page.setViewportSize({ width: 800, height: 600 });
  await check('minimum-window');
  await page.setViewportSize(ui.viewport);
  await check('restored-window');
}
