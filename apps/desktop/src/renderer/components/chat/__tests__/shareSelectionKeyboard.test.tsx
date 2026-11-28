/**
 * 测试价值
 * - 生产入口与可观察结果：真实 ShareSelectionBar + ShareMessageCheckbox + shareSelectionStore。
 *   图片分享模式下，焦点停在刚勾选的消息勾选框上时，Esc 退出分享、⌘/Ctrl+A 全选；
 *   焦点在文字输入框里时这两个键仍让给输入框。
 * - Bug／规则依据：#12342 评审 PRRT_kwDOTgdRUs67KjKu。勾选框从 button role=checkbox 换成原生
 *   input 后，分享栏的「可编辑目标」判断把它当成文字输入框，Esc 和 ⌘A 都失效。
 * - 现有覆盖缺口：分享栏此前没有键盘测试；editableKeyboardTarget 的现有用例只测卡片快捷键。
 * - 最小失败输入：进入分享模式，点选一条消息并让焦点留在它的勾选框上，按 ⌘A / Esc。
 * - tier：unit（jsdom），无真实等待。
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SHARE_MESSAGE_ATTR, SHARE_SESSION_ATTR } from '@/lib/shareConversationImage';
import { ShareMessageCheckbox } from '../ShareMessageCheckbox';
import { ShareSelectionBar } from '../ShareSelectionBar';
import { shareSelectionStore } from '../shareSelectionStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useBrandLogo', () => ({ useBrandLogo: () => '' }));

const SESSION = 'share-session';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  shareSelectionStore.reset();
  shareSelectionStore.enter(SESSION);
});

afterEach(() => {
  cleanup();
  shareSelectionStore.reset();
  vi.unstubAllGlobals();
});

function renderShareMode() {
  render(
    <div>
      {['m1', 'm2'].map((id) => (
        <div key={id} {...{ [SHARE_SESSION_ATTR]: SESSION, [SHARE_MESSAGE_ATTR]: id }} className="relative">
          <ShareMessageCheckbox clientId={id} />
          message {id}
        </div>
      ))}
      <input aria-label="Draft" />
      <ShareSelectionBar sessionId={SESSION} getContentWidth={() => 600} barWidth={600} />
    </div>,
  );
  return screen.getAllByRole('checkbox', { name: 'chat.shareImage.checkboxLabel' })[0]!;
}

it('keeps Escape and ⌘/Ctrl+A for the share bar while a message checkbox has focus', () => {
  const checkbox = renderShareMode();
  fireEvent.click(checkbox);
  checkbox.focus();
  expect(shareSelectionStore.getSelectedIds()).toEqual(['m1']);

  act(() => { fireEvent.keyDown(checkbox, { key: 'a', metaKey: true }); });
  expect(shareSelectionStore.getSelectedIds().sort()).toEqual(['m1', 'm2']);

  act(() => { fireEvent.keyDown(checkbox, { key: 'Escape' }); });
  expect(shareSelectionStore.isActive(SESSION)).toBe(false);
});

it('still leaves Escape and ⌘/Ctrl+A to a text field', () => {
  renderShareMode();
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();

  act(() => { fireEvent.keyDown(draft, { key: 'a', ctrlKey: true }); });
  expect(shareSelectionStore.count()).toBe(0);

  act(() => { fireEvent.keyDown(draft, { key: 'Escape' }); });
  expect(shareSelectionStore.isActive(SESSION)).toBe(true);
});
