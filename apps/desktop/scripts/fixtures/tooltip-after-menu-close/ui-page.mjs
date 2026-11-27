// 菜单关闭后的焦点回收不应该把提示弹出来（指针全程不在按钮上）；hover 与键盘焦点照旧。
export default {
  name: 'tooltip-after-menu-close',
  entry: './tooltip-after-menu-close.tsx',
  viewport: { width: 720, height: 360 },
  real: '共享 Tip + DropdownMenu（会话标题栏「更多操作」的接线）',
  notCovered: '真实会话数据与菜单项业务逻辑',
  cases: { default: { about: '点 ⋯ 打开菜单，再点空白关闭', data: {} } },
  async check(page, ui) {
    const tooltipVisible = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-radix-popper-content-wrapper]')));

    // 1. hover 仍然弹提示
    await page.hover('[aria-label="more"]');
    await page.waitForSelector('[data-radix-popper-content-wrapper]');
    await page.mouse.move(620, 300);
    await page.waitForTimeout(400);
    if (await tooltipVisible()) throw new Error('指针离开按钮后提示没有关闭');

    // 2. 点 ⋯ 打开菜单，再点空白关闭：焦点回到按钮，但指针不在按钮上
    await page.click('[aria-label="more"]');
    await page.waitForSelector('[role="menu"]');
    await ui.capture('menu-open');
    await page.mouse.click(620, 300);
    await page.waitForTimeout(900);
    // 先确认焦点确实回到了按钮，否则「没有提示」可能只是菜单没有回收焦点。
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    if (focused !== 'more') throw new Error(`菜单关闭后焦点没有回到 ⋯ 按钮（activeElement=${focused}）`);
    const phantom = await tooltipVisible();
    await ui.capture('after-outside-click');
    if (phantom) throw new Error('菜单关闭后没有悬停也弹出了提示');

    // 3. 键盘焦点照旧弹提示（先失焦，再从页面起点 Tab 回按钮，确保是键盘模态）
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(600);
    const keyboardTip = await tooltipVisible();
    await ui.capture('keyboard-focus');
    if (!keyboardTip) throw new Error('键盘焦点没有弹出提示');
  },
};
