export default {
  name: 'message-nav-rail-preview',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 420 },
  real: 'MessageNavRail hover preview with the production entry projection, chat source labels, tooltip, typography and theme',
  notCovered: 'Full MessageStream scrolling and live message sources; the chat history comes from the fixture',
  cases: {
    default: { about: '悬停本人的提问：首行写「你」，问题在与用户气泡同色的圆角框里' },
    worker: { about: '悬停 Orca Worker 的回报：首行写聊天同款来源，正文次级色，不加框' },
  },
  async check(page, ui) {
    const own = ui.case === 'default';
    await page.locator(`[data-message-nav-index="${own ? 0 : 1}"]`).hover();
    // Radix 另渲染一份 1×1 的读屏副本，截图和放大都以可见的弹层容器为准。
    const card = page.locator('[data-radix-popper-content-wrapper]');
    await card.getByText(own ? '这次重构对移动端有影响吗？' : '桌面端检查完成').first().waitFor();
    await ui.capture(own ? 'own' : 'worker');
    const heading = own ? await ui.t('chat.messageNavRail.you') : await ui.t('chat.userMessage.orcaFromWorker');
    await card.getByText(heading).first().waitFor();
  },
};
