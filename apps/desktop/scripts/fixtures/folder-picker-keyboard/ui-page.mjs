/**
 * 项目选择器搜索框的方向键导航(#11653)。
 *
 * 场景给 30 个项目,远超列表 252px 的可视高度,用来覆盖「方向键把高亮带出可视区后
 * 仍看得见当前项」——这条在 jsdom 里做不到(没有 scrollIntoView),只能在这里验证。
 */
export default {
  name: 'folder-picker-keyboard',
  entry: './entry.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'FolderPickerPopover 搜索框的方向键高亮、滚动定位与 Enter 选择',
  notCovered: '真实项目扫描与数据库读取、浮层外的页面其余部分;方向键与滚动的断言见本文件的 check()',
  cases: {
    default: { about: '30 个项目的选择器:方向键高亮越过可视边缘后仍可见' },
  },

  async check(page, ui) {
    // 搜索框的 aria-label 是翻译后的文案,跨语言不稳定,按浮层结构定位。
    const input = page.locator('[role="dialog"] input[type="text"]').first();
    await input.waitFor();

    await input.fill('project');
    // 过滤后仍是 30 项;下拉到第 10 项,一定超出首屏。
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('ArrowDown');
    }

    const list = page.locator('[data-folder-picker-scroll="true"]').first();
    const highlighted = page.locator('[data-folder-picker-index="10"]');
    const listBox = await list.boundingBox();
    const rowBox = await highlighted.boundingBox();
    if (!listBox || !rowBox) {
      throw new Error('找不到列表容器或高亮行');
    }
    const top = listBox.y;
    const bottom = listBox.y + listBox.height;
    // 允许 1px 亚像素误差。
    if (rowBox.y < top - 1 || rowBox.y + rowBox.height > bottom + 1) {
      throw new Error(
        `高亮行没有被滚入可视区: row=${Math.round(rowBox.y)}..${Math.round(
          rowBox.y + rowBox.height,
        )} list=${Math.round(top)}..${Math.round(bottom)}`,
      );
    }

    // 高亮必须真的跟着方向键走,而不是固定在第一行。
    const firstRow = page.locator('[data-folder-picker-index="0"]');
    const firstClass = (await firstRow.getAttribute('class')) ?? '';
    if (firstClass.split(/\s+/).includes('bg-[var(--folder-item-hover)]')) {
      throw new Error('高亮仍停在第一项,方向键没有移动高亮');
    }

    // Grid 只有当前项目的选择按钮进入 Tab 顺序;行内左右键能独立到达删除按钮。
    await page.keyboard.press('Tab');
    if (
      !(await highlighted
        .getByRole('button')
        .first()
        .evaluate((el) => el === document.activeElement))
    ) {
      throw new Error('Tab 没有进入当前高亮项目');
    }
    await page.keyboard.press('ArrowRight');
    if (
      !(await highlighted
        .getByRole('button')
        .last()
        .evaluate((el) => el === document.activeElement))
    ) {
      throw new Error('方向键无法独立聚焦删除按钮');
    }
    await ui.capture('remove-focused');
    await page.keyboard.press('Shift+Tab');
    if (!(await input.evaluate((el) => el === document.activeElement))) {
      throw new Error('Shift+Tab 没有直接离开 Grid 返回搜索框');
    }
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    if (
      !(await input.evaluate((el) => el === document.activeElement)) ||
      (await input.inputValue()) !== 'project'
    ) {
      throw new Error('Esc 没有返回搜索框并保留查询');
    }
  },
};
