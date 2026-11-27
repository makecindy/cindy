// 会话行 hover 浮层（PR 引用 / 来源标签）的收口场景：指针离开行要关，窗口失活
// （切到别的窗口，行收不到 pointerleave）也要关。行的开关状态照抄 SessionItem：
// onPointerOver 开、onPointerLeave 关、受控 open 的关闭请求回灌 onOpenChange。
export default {
  name: 'hover-tooltip-window-blur',
  entry: './hover-tooltip-window-blur.tsx',
  viewport: { width: 900, height: 360 },
  real: 'SessionTooltip 的 PR 浮层与行级受控 open 接线',
  notCovered: '真实 gh 状态查询、真实操作系统级窗口切换',
  cases: { default: { about: '悬停任务行，指针离开 / 窗口失活', data: {} } },
  async check(page, ui) {
    const visible = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-radix-popper-content-wrapper]')));
    const settle = () => page.waitForTimeout(400);

    // 1. 悬停 → 浮层出现
    await page.hover('[data-hover-row]');
    await page.waitForSelector('[data-radix-popper-content-wrapper]');
    await settle();
    await ui.capture('hovered');

    // 2. 指针离开行 → 浮层关闭
    await page.mouse.move(700, 260);
    await settle();
    if (await visible()) throw new Error('指针离开行后浮层没有关闭');

    // 3. 悬停 → 窗口失活（指针没离开行）→ 浮层也必须关闭
    await page.hover('[data-hover-row]');
    await page.waitForSelector('[data-radix-popper-content-wrapper]');
    await settle();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await settle();
    const stillOpen = await visible();
    await ui.capture('after-blur');
    if (stillOpen) throw new Error('窗口失活后 hover 浮层仍留在屏幕上');
  },
};
