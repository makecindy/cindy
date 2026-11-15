import companion from '../companion-message-actions/ui-page.mjs';
export default {
  name: 'pending-queue-gallery',
  entry: './fixture.tsx',
  viewport: { width: 960, height: 780 },
  real: 'PendingQueueBubble, UserMessage, ChatInput, ErrorBanner, CredentialSwitchWaitBanner and menus',
  notCovered:
    'Sample state, not live host dispatch. Task-page inline paused/stopping rows are composed here. No real offline outbox or upload lifecycle.',
  stubs: companion.stubs,
  cases: Object.fromEntries(
    Object.entries({
      'attachment-only': '只发附件，没有文字',
      'files-only': '只发文件',
      quote: '引用消息',
      device: '从手机发来的消息',
      autoretry: '自动重试中',
      quota: '额度不足',
      default: '正常排队',
      single: '只有一条消息',
      menu: '队首、中间和队尾菜单',
      editing: '编辑中与底部输入框',
      sending: '尚未确认入队',
      steering: '插话发送中',
      paused: '停止后队列暂停',
      stopping: '正在确认停止',
      error: '发送错误',
      credential: '等待切换凭证',
      'remote-edit': '另一端正在编辑',
      locked: '队列操作锁定',
      readonly: '只读状态',
      many: '六条消息全部展示',
      long: '长消息折叠与展开',
      attachments: '图片与文件附件',
      companion: '伙伴聊天附件布局',
      sources: '其他任务、插件和自动化来源',
      synthetic: '系统续跑指令',
      delivered: '正式送达后的消息',
      empty: '队列清空',
    }).map(([key, about]) => [key, { about }]),
  ),
  async ready(page) {
    await page.locator('[contenteditable=true]').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'error' || ui.case === 'quota') {
      const details = page.getByRole('button', {
        name: await ui.t('chat.errorBanner.networkShowRaw'),
        exact: true,
      });
      if (await details.count()) {
        await details.click();
        await ui.capture('error-details');
      }
    }
    if (ui.case === 'editing') {
      await page
        .locator('[contenteditable=true]')
        .fill('先核对手机版的消息排队逻辑，再整理成对照表。');
      await ui.capture('editing-text');
    }
    if (ui.case === 'menu') {
      for (const id of ['first', 'second', 'third']) {
        await page
          .locator(`[data-pending-queue-message="${id}"]`)
          .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
          .click();
        await page.getByRole('menu').waitFor();
        await ui.capture(`menu-${id}`);
        await page.keyboard.press('Escape');
      }
    }
    if (ui.case === 'menu') {
      await page
        .locator('[data-pending-queue-message="second"]')
        .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: await ui.t('newChat.pendingQueue.moveUp'), exact: true })
        .click();
      await ui.capture('reordered');
    }
    if (ui.case === 'long') {
      const button = page
        .locator('[data-pending-queue-message="first"]')
        .getByRole('button', {
          name: await ui.t('chat.userMessage.expandLongMessage'),
          exact: true,
        });
      if (await button.count()) {
        await button.click();
        await ui.capture('expanded');
      }
    }
    if (ui.case === 'paused') {
      await page
        .getByRole('button', { name: await ui.t('newChat.pendingQueue.resumeAction'), exact: true })
        .click();
      await ui.capture('resumed');
    }
    if (ui.case === 'sources' || ui.case === 'single') {
      await page
        .locator('[data-pending-queue-message="first"]')
        .getByRole('button', { name: await ui.t('newChat.pendingQueue.queued'), exact: true })
        .click();
      await page.getByRole('menu').waitFor();
      await ui.capture('available-actions');
    }
  },
};
