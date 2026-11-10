// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { BotLearningFooter } from '../BotLearningFooter';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args: { title: string }) => `${key}: ${args.title}` }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function Location() {
  return <output>{useLocation().search}</output>;
}
function Route() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}
it('renders two footer rows after content and opens only the existing settings pages', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const receipts = [
    { kind: 'memory', key: 'a', title: 'Preference', action: 'created' },
    { kind: 'skill', key: 'b', title: 'Workflow', action: 'updated' },
  ];
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/bots/b/session/s']}>
        <article>
          <p>Reply</p>
          <BotLearningFooter receipts={receipts} />
        </article>
        <Location />
      </MemoryRouter>,
    ),
  );
  expect(host.querySelector('article')!.firstElementChild!.textContent).toBe('Reply');
  expect(
    host.querySelector('[data-bot-learning-footer]')!.previousElementSibling!.textContent,
  ).toBe('Reply');
  const buttons = host.querySelectorAll('button');
  expect(buttons.length).toBe(2);
  await act(async () => buttons[0].click());
  expect(host.querySelector('output')!.textContent).toBe('?settings=1&settingsPage=memory');
  await act(async () => buttons[1].click());
  expect(host.querySelector('output')!.textContent).toBe('?settings=1&settingsPage=capabilities');
  await act(async () => root.unmount());
  host.remove();
});
// 普通任务的保存回执(docs/product-rules/cindy-memory.md §4): 只有记忆一行。回执只带「写的是哪一份」
// (关于你 / 项目), 不带路径; 本机任务点开设置里的「查看记忆」—— 写的是项目那份就带上这个任务的
// 工作目录让 main 选中它的项目, 否则落在「关于你」。记忆在别的电脑上的任务只显示文字。
// 伙伴的行为由上一条用例锁住。
it.each([
  ['task', 'project', '/settings?tab=personalization&openPanel=memory&memoryTask=%2Frepo%2Fapps'],
  ['task', 'user', '/settings?tab=personalization&openPanel=memory'],
  ['task-readonly', 'project', null],
] as const)('an ordinary task receipt (%s, %s memory) shows the memory row only and opens %s', async (surface, scope, opened) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const receipts = [
    { kind: 'memory', key: 'a', title: 'Preference', action: 'created', scope },
    { kind: 'skill', key: 'b', title: 'Workflow', action: 'updated' },
  ];
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/session/s']}>
        <BotLearningFooter receipts={receipts} surface={surface} task={{ workingDir: '/repo/apps' }} />
        <Route />
      </MemoryRouter>,
    ),
  );
  const footer = host.querySelector('[data-bot-learning-footer]')!;
  expect(footer.textContent).toBe('bots.learning.memory: Preference');
  const buttons = footer.querySelectorAll('button');
  expect(buttons.length).toBe(opened ? 1 : 0);
  if (opened) {
    await act(async () => buttons[0].click());
    expect(host.querySelector('output')!.textContent).toBe(opened);
  }
  await act(async () => root.unmount());
  host.remove();
});
// 消息列表也会渲染在没有路由的地方(预览、导出): 回执退化成一行文字, 不能让整条消息崩掉。
it('renders a receipt as plain text where there is no router to navigate with', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const receipts = [{ kind: 'memory', key: 'a', title: 'Preference', action: 'created' }];
  await act(async () => root.render(<BotLearningFooter receipts={receipts} surface="task" />));
  expect(host.textContent).toBe('bots.learning.memory: Preference');
  expect(host.querySelectorAll('button').length).toBe(0);
  await act(async () => root.unmount());
});
