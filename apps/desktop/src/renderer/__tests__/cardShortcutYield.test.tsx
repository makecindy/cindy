// @vitest-environment jsdom
/**
 * 替代输入框的交互卡片（授权 / 计划审批 / 提问）在 window 上挂着回车、Esc、数字键快捷键。
 * 这些按键只在「无人认领」时才能替用户做决定：
 * - 焦点在「拒绝」上按回车，结果必须是拒绝（按钮自己激活），不能变成「允许一次」；
 * - 在下拉菜单里用回车选项、用 Esc 关菜单，不能顺带批准或取消计划；
 * - 在侧栏搜索等别处的输入框里打数字，不能替用户选中提问的选项。
 * 以及 Mermaid 源码编辑器：点遮罩不能丢掉未保存的修改。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (original) => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import { MermaidSourceEditorHost } from '@/components/markdown/MermaidSourceEditor';
import { MERMAID_EDIT_EVENT } from '@/components/markdown/markdownMermaidLivePreview';
import { AskUserQuestionPrompt } from '@/components/new-chat/AskUserQuestionPrompt';
import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';
import { GhostGrantConfirmCard } from '@/features/cc-agent/GhostGrantConfirmCard';
import { IssueConfirmCard } from '@/features/cc-agent/IssueConfirmCard';
import { RenameSessionsConfirmCard } from '@/features/cc-agent/RenameSessionsConfirmCard';
import { shouldCardEscapeYield, shouldCardShortcutYield } from '@/lib/editableKeyboardTarget';
import type { PendingPermission } from '@/lib/makerChatStore';

afterEach(cleanup);

/** 页面上另一处的下拉菜单与输入框，模拟侧栏搜索、Radix 菜单等卡片外的焦点。 */
function Elsewhere() {
  return createElement(
    'div',
    null,
    createElement('input', {'aria-label': 'sidebar-search'}),
    createElement('div', {role: 'menu'}, createElement('div', {role: 'menuitem', tabIndex: -1}, 'Rename')),
    createElement('button', {type: 'button'}, 'toolbar'),
  );
}

function keyOn(target: Element, key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, {key, ...init});
}

describe('shouldCardShortcutYield', () => {
  let owner: HTMLDivElement;
  let ownButton: HTMLButtonElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    owner = document.createElement('div');
    ownButton = document.createElement('button');
    owner.append(ownButton);
    document.body.append(owner);
  });
  const event = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true, ...init});
    Object.defineProperty(e, 'target', {value: target});
    return e;
  };

  it('无人认领的按键不让位', () => {
    expect(shouldCardShortcutYield(event(document.body), 'activate', owner)).toBe(false);
    expect(shouldCardShortcutYield(event(document.body, {key: 'Escape'}), 'dismiss', owner)).toBe(false);
  });

  it('已被处理或输入法组字中的按键让位', () => {
    const handled = event(document.body);
    handled.preventDefault();
    expect(shouldCardShortcutYield(handled, 'activate', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(document.body, {isComposing: true}), 'activate', owner)).toBe(true);
  });

  it('卡片自己的按钮：普通回车让给按钮激活，带修饰键的回车仍归卡片', () => {
    expect(shouldCardShortcutYield(event(ownButton), 'activate', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(ownButton), 'modifiedActivate', owner)).toBe(false);
    expect(shouldCardShortcutYield(event(ownButton, {key: 'Escape'}), 'dismiss', owner)).toBe(false);
    expect(shouldCardShortcutYield(event(ownButton, {key: '1'}), 'character', owner)).toBe(false);
  });

  it('卡片外的控件与浮层一律让位', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const plain = document.createElement('div');
    menu.append(plain);
    const outsideButton = document.createElement('button');
    // MorphPopover 面板是 role="group"，靠 data-morph-side 认出它是浮层。
    const morph = document.createElement('div');
    morph.setAttribute('role', 'group');
    morph.setAttribute('data-morph-side', 'top');
    document.body.append(menu, outsideButton, morph);
    expect(shouldCardShortcutYield(event(plain, {key: 'Escape'}), 'dismiss', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(morph, {key: 'Escape'}), 'dismiss', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(morph, {key: 'Enter'}), 'activate', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(outsideButton, {key: 'Escape'}), 'dismiss', owner)).toBe(true);
    expect(shouldCardShortcutYield(event(outsideButton, {key: '1'}), 'character', owner)).toBe(true);
  });
});

function permission(suggestions?: unknown[]): PendingPermission {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    input: {command: 'ls'},
    ...(suggestions ? {suggestions} : {}),
  };
}

describe('PermissionPrompt 快捷键不替用户误批', () => {
  it('焦点在「拒绝」上按回车，由按钮原生激活并执行拒绝', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(createElement(PermissionPrompt, {permission: permission(), onRespond}));
    const deny = screen.getByRole('button', {name: /agentIsland\.native\.deny/});
    deny.focus();
    await user.keyboard('{Enter}');
    expect(onRespond).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'User denied',
      decisionClassification: 'user_reject',
    });
  });

  it('焦点在卡片按钮上按 Ctrl/⌘+Enter，仍执行本对话都允许', () => {
    const onRespond = vi.fn();
    render(
      createElement(PermissionPrompt, {
        permission: permission([
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'curl:*' }],
            behavior: 'allow',
            destination: 'session',
          },
        ]),
        onRespond,
      }),
    );
    const deny = screen.getByRole('button', { name: /agentIsland\.native\.deny/ });
    const allowOnce = screen.getByRole('button', { name: /agentIsland\.native\.allowOnce/ });

    deny.focus();
    keyOn(deny, 'Enter', { ctrlKey: true });
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );

    onRespond.mockClear();
    allowOnce.focus();
    keyOn(allowOnce, 'Enter', { metaKey: true });
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });

  it('在卡片外的菜单里按 Esc 关菜单，不会顺带拒绝', () => {
    const onRespond = vi.fn();
    render(createElement('div', null, createElement(Elsewhere), createElement(PermissionPrompt, {permission: permission(), onRespond})));
    keyOn(screen.getByRole('menuitem'), 'Escape');
    keyOn(screen.getByRole('menuitem'), 'Enter');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('焦点不在任何控件上时，回车仍是「允许一次」、Esc 仍是拒绝', () => {
    const onRespond = vi.fn();
    render(createElement(PermissionPrompt, {permission: permission(), onRespond}));
    keyOn(document.body, 'Enter');
    expect(onRespond).toHaveBeenLastCalledWith({behavior: 'allow'});
    keyOn(document.body, 'Escape');
    expect(onRespond).toHaveBeenLastCalledWith(expect.objectContaining({behavior: 'deny'}));
  });
});

describe('PlanActionCard 快捷键不跟着菜单一起触发', () => {
  it('在菜单里用回车选项、用 Esc 关菜单，不会批准或取消计划', () => {
    const onRespond = vi.fn();
    const onCancel = vi.fn();
    render(createElement('div', null, createElement(Elsewhere), createElement(PlanActionCard, {requestId: 'p1', onRespond, onCancel})));
    keyOn(screen.getByRole('menuitem'), 'Enter');
    keyOn(screen.getByRole('menuitem'), 'Escape');
    keyOn(screen.getByText('toolbar'), 'Escape');
    expect(onRespond).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('焦点不在任何控件上时，回车仍批准计划', () => {
    const onRespond = vi.fn();
    render(createElement(PlanActionCard, {requestId: 'p2', onRespond, onCancel: vi.fn()}));
    keyOn(document.body, 'Enter');
    expect(onRespond).toHaveBeenCalledWith('p2', true);
  });
});

describe('AskUserQuestionPrompt 数字键只在无人认领时作答', () => {
  function renderAsk(onAnswer = vi.fn()) {
    render(createElement('div', null, createElement(Elsewhere), createElement(AskUserQuestionPrompt, {
      sessionId: 's1',
      pending: {requestId: 'q1', questions: [{question: 'Which?', options: [{label: 'A'}, {label: 'B'}]}]},
      onAnswer,
      viewerState: 'expanded',
      onViewerStateChange: () => {},
      draft: null,
      onDraftChange: () => {},
    })));
    return onAnswer;
  }

  it('在别处的输入框里打数字、在菜单里按 Esc，不会作答或跳过', () => {
    const onAnswer = renderAsk();
    keyOn(screen.getByLabelText('sidebar-search'), '1');
    keyOn(screen.getByRole('menuitem'), 'Escape');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('焦点不在任何控件上时，数字键仍选中对应选项', () => {
    const onAnswer = renderAsk();
    keyOn(document.body, '2');
    expect(onAnswer).toHaveBeenCalledWith('q1', {'Which?': 'B'});
  });
});

describe('shouldCardEscapeYield', () => {
  it('卡片自己的输入框里 Esc 仍归卡片，卡片外的输入框、浮层、已处理的按键让位', () => {
    document.body.innerHTML = '';
    const owner = document.createElement('div');
    const ownInput = document.createElement('input');
    owner.append(ownInput);
    const outsideInput = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogCheckbox = document.createElement('button');
    dialogCheckbox.setAttribute('role', 'checkbox');
    dialog.append(dialogCheckbox);
    document.body.append(owner, outsideInput, dialog);
    const escape = (target: EventTarget, init: KeyboardEventInit = {}) => {
      const e = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true, ...init});
      Object.defineProperty(e, 'target', {value: target});
      return e;
    };
    expect(shouldCardEscapeYield(escape(document.body), owner)).toBe(false);
    expect(shouldCardEscapeYield(escape(ownInput), owner)).toBe(false);
    expect(shouldCardEscapeYield(escape(ownInput, {isComposing: true}), owner)).toBe(true);
    expect(shouldCardEscapeYield(escape(outsideInput), owner)).toBe(true);
    expect(shouldCardEscapeYield(escape(dialogCheckbox), owner)).toBe(true);
    const handled = escape(document.body);
    handled.preventDefault();
    expect(shouldCardEscapeYield(handled, owner)).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('确认卡片的 Esc 不抢别处对话框的按键', () => {
  /** 卡片外的对话框（如侧栏「自定义」面板），焦点停在它的勾选框上。 */
  function OtherDialog() {
    return createElement(
      'div',
      {role: 'dialog', 'aria-label': 'customize'},
      createElement('button', {type: 'button', role: 'checkbox', 'aria-checked': true, 'aria-label': 'entry'}),
    );
  }
  const cards = [
    {
      name: 'IssueConfirmCard',
      render: (onRespond: () => void) => createElement(IssueConfirmCard, {
        sessionId: 'session-esc',
        pending: {
          requestId: 'issue-esc',
          draft: {title: 't', body: 'b', type: 'bug'},
          env: {appVersion: '0.1.0', platform: 'darwin', arch: 'arm64', osVersion: '15'},
          submissionIdentity: {kind: 'platform', login: 'cindy-issue'},
        },
        onRespond,
      }),
    },
    {
      name: 'RenameSessionsConfirmCard',
      render: (onRespond: () => void) => createElement(RenameSessionsConfirmCard, {
        pending: {
          requestId: 'rename-esc',
          changes: [{sessionId: 's1', currentTitle: 'a', newTitle: 'b', workingDir: null, updatedAt: '2026-11-05T00:00:00Z'}],
        },
        onRespond,
      }),
    },
    {
      name: 'GhostGrantConfirmCard',
      render: (onRespond: () => void) => createElement(GhostGrantConfirmCard, {
        pending: {
          requestId: 'grant-esc',
          ghostId: 'g',
          ghostName: 'G',
          lane: 'dir',
          items: [{name: 'a.txt', absPath: '/tmp/a.txt', size: 1}],
        },
        onRespond,
      }),
    },
  ];

  it.each(cards)('$name：焦点在别处的对话框里时 Esc 不取消，焦点不在任何控件上时仍取消', ({render: renderCard}) => {
    const onRespond = vi.fn();
    render(createElement('div', null, renderCard(onRespond), createElement(OtherDialog)));
    keyOn(screen.getByRole('checkbox', {name: 'entry'}), 'Escape');
    expect(onRespond).not.toHaveBeenCalled();
    keyOn(document.body, 'Escape');
    expect(onRespond).toHaveBeenCalledWith({confirmed: false});
  });
});

describe('MermaidSourceEditor 点遮罩不丢草稿', () => {
  it('点遮罩不关闭，取消按钮仍可关闭', () => {
    vi.useFakeTimers();
    try {
      const applyEdit = vi.fn(() => 'applied' as const);
      render(createElement(MermaidSourceEditorHost));
      act(() => {
        window.dispatchEvent(new CustomEvent(MERMAID_EDIT_EVENT, {detail: {source: 'graph TD', applyEdit}}));
      });
      const textarea = screen.getByRole('dialog').querySelector('textarea')!;
      fireEvent.change(textarea, {target: {value: 'graph LR'}});
      const scrim = screen.getByRole('dialog').previousElementSibling as HTMLElement;
      fireEvent.click(scrim);
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByRole('dialog').querySelector('textarea')!.value).toBe('graph LR');

      fireEvent.click(screen.getByText('ccAgent.workdirBrowse.mermaidEditor.cancel'));
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(applyEdit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
