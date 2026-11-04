// @vitest-environment jsdom
/**
 * PermissionPrompt.test.tsx — 「本对话都允许」按钮的范围表达。
 *
 * 这个按钮加的是 agent 给的一条具体规则,范围远小于「总是允许」的字面。原文案既没说
 * 允许的是哪一类,也容易被读成「什么都允许」。这里锁死:能描述规则时范围出现在按钮上,
 * 描述不出来时退回原文案(而不是编一个范围),以及按钮的授权载荷一字不改地转发 agent
 * 建议 —— 文案怎么写都不该动实际授权内容。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingPermission } from '@/lib/makerChatStore';
import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../../shared/providerShareCredentialConsent';

// 仓库同款 i18n mock:t 返回 key(带参时拼上参数便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

// Tip 是 Radix 浮层,这里不测浮层行为,但 text 必须落到 DOM 里 ——
// tooltip 正文也是授权文案,漏测就等于放过「说了没依据的话」这类问题。
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children, text }: { children: React.ReactNode; text?: string }) => (
    <>
      {children}
      <span data-testid="tip-text">{text}</span>
    </>
  ),
}));

import { PermissionPrompt } from '../PermissionPrompt';
import { InteractionPromptHost } from '@/components/interaction-portal';
import { setSlotElement } from '@/components/interaction-portal/store';
import { useSessionSwitchFocusIntent } from '@/features/cc-agent/useSessionSwitchFocusIntent';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

afterEach(cleanup);

const bashRule = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'curl:*' }],
  behavior: 'allow',
  destination: 'session',
};

function permission(suggestions?: unknown[]): PendingPermission {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'curl -s https://example.com' },
    ...(suggestions ? { suggestions } : {}),
  };
}

describe('PermissionPrompt 的会话级授权按钮', () => {
  it('供应商分享的凭证确认提供本任务允许，并回传本机提供的授权标记', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={permission([PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL])} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /alwaysAllowForSession/ }));
    expect(onRespond).toHaveBeenCalledWith({
      behavior: 'allow',
      updatedPermissions: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
      decisionClassification: 'user_permanent',
    });
  });
  it('提交中禁用按钮和快捷键，失败后允许重试', () => {
    const onRespond = vi.fn();
    const request = permission([bashRule]);
    const { rerender } = render(<PermissionPrompt permission={{ ...request, submitting: true }} onRespond={onRespond} />);
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('newChat.permissionPrompt.submitting');
    rerender(<PermissionPrompt permission={{ ...request, submitting: false, submissionFailed: true }} onRespond={onRespond} />);
    expect(screen.getByRole('status').textContent).toBe('newChat.permissionPrompt.submissionFailed');
    fireEvent.click(screen.getByRole('button', { name: /allowOnce/ }));
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' });
  });

  it('把规则范围写进按钮文案', () => {
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={vi.fn()} />);

    expect(
      screen.getByText('newChat.permissionPrompt.alwaysAllowScoped:{"scope":"Bash(curl:*)"}'),
    ).toBeTruthy();
  });

  it('规则描述不出来时退回原文案,不编造范围', () => {
    const unknownShape = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };
    render(<PermissionPrompt permission={permission([unknownShape])} onRespond={vi.fn()} />);

    expect(screen.getByText('agentIsland.native.alwaysAllowForSession')).toBeTruthy();
    expect(screen.queryByText(/alwaysAllowScoped:/)).toBeNull();
  });

  // Codex 的会话级放行只给一个不带规则的标记(范围由 app-server 定),这条分支必然走到。
  // 此时 tooltip 不许说「只限这里列出的范围」—— 一条都没列出,那句话是虚假安心。
  it('列不出范围时提示只讲时效,不声称范围', () => {
    render(
      <PermissionPrompt
        permission={permission([{ type: 'codexSessionApproval', destination: 'session' }])}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByTestId('tip-text').textContent).toBe(
      'newChat.permissionPrompt.alwaysAllowSessionHint',
    );
  });

  // 有范围时反过来:完整规则原文进 tooltip(按钮里长命令会被 truncate)。
  it('有范围时提示带上完整规则与范围限定', () => {
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={vi.fn()} />);

    expect(screen.getByTestId('tip-text').textContent).toBe(
      'Bash(curl:*)\nnewChat.permissionPrompt.alwaysAllowScopedHint',
    );
  });

  // 点击会把 suggestions 里每一项都转发出去。混进一项没写进文案的授权(这里是 setMode)
  // 时必须退回原文案 —— 否则按钮一边宣称「只允许 Bash(curl:*)」,一边顺手改权限档位。
  it('授权项描述不全时不做范围声明', () => {
    render(
      <PermissionPrompt
        permission={permission([
          bashRule,
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ])}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText('agentIsland.native.alwaysAllowForSession')).toBeTruthy();
    expect(screen.queryByText(/alwaysAllowScoped:/)).toBeNull();
    // tooltip 也不许替按钮把范围声明补回来。
    expect(screen.getByTestId('tip-text').textContent).toBe(
      'newChat.permissionPrompt.alwaysAllowSessionHint',
    );
  });

  // 分隔符按语言取(中日顿号 / 英韩逗号),不能把顿号漏进英文句子。
  it('多条规则用当前语言的分隔符拼接', () => {
    render(
      <PermissionPrompt
        permission={permission([
          {
            type: 'addRules',
            rules: [
              { toolName: 'Bash', ruleContent: 'curl:*' },
              { toolName: 'Bash', ruleContent: 'git:*' },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ])}
        onRespond={vi.fn()}
      />,
    );

    // i18n mock 下 ruleSeparator 返回 key 本身,断言两条规则都在、且中间是分隔符 key。
    expect(
      screen.getByRole('button', { name: /alwaysAllowScoped:/ }).textContent,
    ).toContain('Bash(curl:*)newChat.permissionPrompt.ruleSeparatorBash(git:*)');
  });

  it('没有会话级建议时整个按钮不出现', () => {
    render(<PermissionPrompt permission={permission()} onRespond={vi.fn()} />);

    expect(screen.queryByText('agentIsland.native.alwaysAllowForSession')).toBeNull();
    expect(screen.queryByText(/alwaysAllowScoped/)).toBeNull();
    // 另两个出口照常。
    expect(screen.getByText('agentIsland.native.allowOnce')).toBeTruthy();
    expect(screen.getByText('agentIsland.native.deny')).toBeTruthy();
  });

  // 文案是展示层的事,授权载荷必须原样转发 agent 的建议 —— 改文案不许改语义。
  it('点击后原样转发 agent 建议作为授权载荷', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={onRespond} />);

    fireEvent.click(
      screen.getByText('newChat.permissionPrompt.alwaysAllowScoped:{"scope":"Bash(curl:*)"}'),
    );

    expect(onRespond).toHaveBeenCalledWith({
      behavior: 'allow',
      updatedPermissions: [bashRule],
      decisionClassification: 'user_permanent',
    });
  });

  it('Ctrl+Enter 与点击等价', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={permission([bashRule])} onRespond={onRespond} />);

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });
});

describe('PermissionPrompt 的插件安装确认', () => {
  it('首行作说明，权限清单放进可滚动区域，不显示内部参数', () => {
    render(
      <PermissionPrompt
        permission={{
          requestId: 'req-install',
          toolName: 'cindy.plugin.install',
          input: { ghost_id: 'weather-chip', version: '1.0.0' },
          title: '安装插件「Weather」？',
          description: '版本 1.0.0 · 由 Agent 发起 · 来自 Cindy 插件市场\n确认后才会安装。\n安装后它将拥有：\n• 访问 api.weather.test',
        }}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText('版本 1.0.0 · 由 Agent 发起 · 来自 Cindy 插件市场')).toBeTruthy();
    const list = screen.getByText(/安装后它将拥有/);
    expect(list.textContent).toContain('• 访问 api.weather.test');
    expect(list.textContent).not.toContain('版本 1.0.0');
    expect(screen.queryByText(/weather-chip/)).toBeNull();
    expect(screen.queryByRole('button', { name: /alwaysAllow/ })).toBeNull();
  });
});

describe('PermissionPrompt 切换任务后聚焦「允许一次」', () => {
  it('autoFocus 时把焦点从侧栏行移到「允许一次」，回车即允许一次', () => {
    const sidebarRow = document.createElement('div');
    sidebarRow.tabIndex = 0;
    document.body.append(sidebarRow);
    sidebarRow.focus();
    const onRespond = vi.fn();
    const onAutoFocusHandled = vi.fn();
    render(
      <PermissionPrompt
        permission={permission()}
        onRespond={onRespond}
        autoFocus
        onAutoFocusHandled={onAutoFocusHandled}
      />,
    );
    const allowOnce = screen.getByRole('button', { name: /allowOnce/ });
    expect(document.activeElement).toBe(allowOnce);
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);
    fireEvent.click(allowOnce);
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' });
    sidebarRow.remove();
  });

  it('不传 autoFocus 时不动焦点', () => {
    render(<PermissionPrompt permission={permission()} onRespond={vi.fn()} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('焦点在别处的输入框或菜单里时不抢焦点，但仍消费意图', () => {
    const search = document.createElement('input');
    document.body.append(search);
    search.focus();
    const onAutoFocusHandled = vi.fn();
    render(
      <PermissionPrompt
        permission={permission()}
        onRespond={vi.fn()}
        autoFocus
        onAutoFocusHandled={onAutoFocusHandled}
      />,
    );
    expect(document.activeElement).toBe(search);
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);
    search.remove();
  });

  // 右栏浏览器是 <webview>：用户点进去打字时，宿主文档里只看到焦点在 webview 元素上，
  // 访客页面的按键本窗口收不到，切换意图也就撤销不了。确认卡这时不能把焦点抢出来。
  it.each(['webview', 'iframe'])('焦点在内嵌页面（%s）里时不抢焦点，但仍消费意图', (tag) => {
    const guest = document.createElement(tag);
    guest.tabIndex = 0;
    document.body.append(guest);
    guest.focus();
    expect(document.activeElement).toBe(guest);
    const onAutoFocusHandled = vi.fn();
    render(
      <PermissionPrompt
        permission={permission()}
        onRespond={vi.fn()}
        autoFocus
        onAutoFocusHandled={onAutoFocusHandled}
      />,
    );
    expect(document.activeElement).toBe(guest);
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);
    guest.remove();
  });

  it('提交中按钮不可聚焦时先保留意图，提交结束后再聚焦', () => {
    const onAutoFocusHandled = vi.fn();
    const request = permission();
    const { rerender } = render(
      <PermissionPrompt
        permission={{ ...request, submitting: true }}
        onRespond={vi.fn()}
        autoFocus
        onAutoFocusHandled={onAutoFocusHandled}
      />,
    );
    expect(onAutoFocusHandled).not.toHaveBeenCalled();
    rerender(
      <PermissionPrompt
        permission={{ ...request, submitting: false, submissionFailed: true }}
        onRespond={vi.fn()}
        autoFocus
        onAutoFocusHandled={onAutoFocusHandled}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /allowOnce/ }));
    expect(onAutoFocusHandled).toHaveBeenCalledTimes(1);
  });
});

// 从文件页（/cc-agent/files/:id）切到等授权的任务：旧路由的 InteractionPromptSlot 在被动
// cleanup 前仍登记着，新视图的卡片先被 portal 进一个已脱离文档的节点，聚焦不会生效；
// 等 slot 注销、卡片回到行内重新挂载后，意图必须还在，焦点才能落到「允许一次」。
describe('PermissionPrompt 经交互卡 portal 切换路由', () => {
  function SwitchedView() {
    const intent = useSessionSwitchFocusIntent('task-b', true, true);
    return (
      <InteractionPromptHost hasInteraction>
        <PermissionPrompt
          permission={permission()}
          onRespond={vi.fn()}
          autoFocus={intent.armed}
          onAutoFocusHandled={intent.consume}
        />
      </InteractionPromptHost>
    );
  }

  afterEach(() => setSlotElement(null));

  it('卡片先渲染进已脱离的 slot 时保留意图，回到行内后聚焦「允许一次」', () => {
    const staleSlot = document.createElement('div');
    setSlotElement(staleSlot);
    render(<SwitchedView />);
    expect(staleSlot.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);

    act(() => setSlotElement(null));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /allowOnce/ }));
  });
});

// 收起侧栏的搜索弹层里选中一个等授权的任务：同一事件里关闭弹层并切换。真实的 Radix
// Popover 要等退场动画播完才卸载，这期间焦点还在弹层里的结果上；卸载后焦点还给搜索按钮。
// 意图必须撑过这段时间，焦点最终落到「允许一次」，而不是停在搜索按钮上。
describe('PermissionPrompt 经搜索弹层切换任务', () => {
  // jsdom 不播动画。按 data-state 给出 popover.tsx 的 float-in / float-out 动画名，
  // Radix Presence 就会像真实环境那样等 animationend 才卸载内容（做法同
  // MyPluginsPage.test.tsx）。jsdom 也没有 CSS.escape，动画名都是普通标识符。
  beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computedStyle(element);
      if (element.hasAttribute('data-state')) {
        Object.defineProperty(style, 'animationName', {
          get: () => (element.getAttribute('data-state') === 'closed' ? 'float-out' : 'float-in'),
        });
      }
      return style;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function SearchSwitch({ onRespond = vi.fn() }: { onRespond?: (r: unknown) => void }) {
    const [open, setOpen] = useState(false);
    const [taskId, setTaskId] = useState('task-a');
    const intent = useSessionSwitchFocusIntent(taskId, true, true);
    return (
      <>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger>search</PopoverTrigger>
          <PopoverContent data-testid="search-popover">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTaskId('task-b');
              }}
            >
              result
            </button>
          </PopoverContent>
        </Popover>
        {taskId === 'task-b' ? (
          <PermissionPrompt
            permission={permission([bashRule])}
            onRespond={onRespond}
            autoFocus={intent.armed}
            onAutoFocusHandled={intent.consume}
          />
        ) : null}
      </>
    );
  }

  it('弹层退场期间保留意图，焦点归还后落到「允许一次」', async () => {
    render(<SearchSwitch />);
    // 像真实收起侧栏那样从搜索按钮打开，Radix 关闭后把焦点还给它。
    const trigger = screen.getByRole('button', { name: 'search' });
    act(() => trigger.focus());
    act(() => trigger.click());
    const result = screen.getByRole('button', { name: 'result' });
    act(() => result.focus());
    // 不经 pointer / 键盘事件触发（那些本身会撤销意图），只看关闭 + 切换的时序。
    act(() => result.click());
    const popover = screen.getByTestId('search-popover');
    expect(popover.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(result);

    const end = new Event('animationend', { bubbles: true });
    Object.defineProperty(end, 'animationName', { value: 'float-out' });
    act(() => {
      fireEvent(popover, end);
    });

    expect(result.isConnected).toBe(false);
    // Radix 在卸载后的下一个 tick 把焦点还给搜索按钮。
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /allowOnce/ }));
  });

  // 在结果上按住 Enter 选中：弹层卸载后、焦点还回来之前，焦点会短暂落到 body，卡片的
  // window 快捷键此时已生效；这段空档里仍在重复的 Enter 不能替用户「允许一次」。
  it('按住 Enter 选中搜索结果，弹层卸载到焦点归还之间的重复不批准', async () => {
    const onRespond = vi.fn();
    render(<SearchSwitch onRespond={onRespond} />);
    const trigger = screen.getByRole('button', { name: 'search' });
    act(() => trigger.focus());
    act(() => trigger.click());
    const result = screen.getByRole('button', { name: 'result' });
    act(() => result.focus());
    act(() => result.click());
    const popover = screen.getByTestId('search-popover');
    fireEvent.keyDown(result, { key: 'Enter', repeat: true });

    const end = new Event('animationend', { bubbles: true });
    Object.defineProperty(end, 'animationName', { value: 'float-out' });
    act(() => {
      fireEvent(popover, end);
    });
    expect(result.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true });
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true, ctrlKey: true });
    expect(onRespond).not.toHaveBeenCalled();

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const allowOnce = screen.getByRole('button', { name: /allowOnce/ });
    expect(document.activeElement).toBe(allowOnce);
    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true, ctrlKey: true });
    fireEvent.keyUp(allowOnce, { key: 'Enter' });
    expect(onRespond).not.toHaveBeenCalled();

    // 新的一次按键照常生效。
    fireEvent.keyDown(allowOnce, { key: 'Enter', ctrlKey: true });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });
});

// 键盘切换：在侧栏行上按住 Enter，第一次 keydown 切任务、焦点随即落到「允许一次」；
// 同一次按住产生的重复 keydown（以及最后的松开）不能激活按钮或卡片快捷键，替用户批准。
describe('PermissionPrompt 键盘切换时不替按住的按键批准', () => {
  function SidebarSwitch({ onRespond }: { onRespond: (r: unknown) => void }) {
    const [switched, setSwitched] = useState(false);
    const intent = useSessionSwitchFocusIntent(switched ? 'task-b' : 'task-a', switched, true);
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          aria-label="sidebar-row"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSwitched(true);
            }
          }}
        />
        {switched ? (
          <PermissionPrompt
            permission={permission([bashRule])}
            onRespond={onRespond}
            autoFocus={intent.armed}
            onAutoFocusHandled={intent.consume}
          />
        ) : null}
      </>
    );
  }

  it.each([
    ['Enter', '{Enter>4}'],
    ['Ctrl+Enter', '{Control>}{Enter>4}'],
    ['Space', '{ >4}'],
  ])('按住 %s 切换后，重复与松开都不批准；再按一次才生效', async (_name, hold) => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<SidebarSwitch onRespond={onRespond} />);
    screen.getByRole('button', { name: 'sidebar-row' }).focus();

    await user.keyboard(hold);
    const allowOnce = screen.getByRole('button', { name: /allowOnce/ });
    expect(document.activeElement).toBe(allowOnce);
    await user.keyboard('{/Enter}{/ }{/Control}');
    expect(onRespond).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' });
  });

  // 真实顺序：键盘切换后确认卡要等挂起交互异步重建才出现，期间用户可能同时按着 Enter
  // 和空格。卡片出现前的重复不能撤销意图；卡片拿到焦点后，先松开其中一个键也不能放行
  // 另一个仍在重复的键。
  it('确认卡晚到且 Enter、空格同时按着时，松开其一后另一个的重复不批准', () => {
    const onRespond = vi.fn();
    function DelayedPrompt() {
      const intent = useSessionSwitchFocusIntent('task-b', true, true);
      const [restored, setRestored] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setRestored(true)}>
            restore
          </button>
          {restored ? (
            <PermissionPrompt
              permission={permission([bashRule])}
              onRespond={onRespond}
              autoFocus={intent.armed}
              onAutoFocusHandled={intent.consume}
            />
          ) : null}
        </>
      );
    }
    render(<DelayedPrompt />);
    // 卡片出现前：两个键都在重复。
    fireEvent.keyDown(window, { key: 'Enter', repeat: true });
    fireEvent.keyDown(window, { key: ' ', repeat: true });
    // 重建完成（用不经 pointer / 键盘的方式触发，免得本身撤销意图）。
    act(() => {
      (screen.getByRole('button', { name: 'restore' }) as HTMLButtonElement).click();
    });
    const allowOnce = screen.getByRole('button', { name: /allowOnce/ });
    expect(document.activeElement).toBe(allowOnce);

    fireEvent.keyUp(allowOnce, { key: ' ' });
    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true });
    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true, ctrlKey: true });
    fireEvent.keyUp(allowOnce, { key: 'Enter' });
    expect(onRespond).not.toHaveBeenCalled();

    // 卡片自己处理的 Ctrl+Enter 能直接看出保护已解除（普通 Enter 交给按钮原生激活，
    // jsdom 不模拟）。
    fireEvent.keyDown(allowOnce, { key: 'Enter', ctrlKey: true });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });

  // 按住 Enter 切换后、松开前再按下 Ctrl：修饰键不能解除保护，仍在重复的 Enter（此时带
  // ctrlKey）不能变成「本对话都允许」。userEvent 无法表达「Enter 一直按着再按 Ctrl」
  // （再写 {Enter>} 会先松开再按），所以按真实事件顺序逐个派发。
  it('按住 Enter 切换后补按 Ctrl，继续重复的 Enter 不批准本对话', () => {
    const onRespond = vi.fn();
    render(<SidebarSwitch onRespond={onRespond} />);
    const row = screen.getByRole('button', { name: 'sidebar-row' });
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const allowOnce = screen.getByRole('button', { name: /allowOnce/ });
    expect(document.activeElement).toBe(allowOnce);

    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true });
    fireEvent.keyDown(allowOnce, { key: 'Control', ctrlKey: true });
    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true, ctrlKey: true });
    fireEvent.keyDown(allowOnce, { key: 'Enter', repeat: true, ctrlKey: true });
    expect(onRespond).not.toHaveBeenCalled();

    // 松开后重新按下 Ctrl+Enter 是一次主动操作，照常生效。
    fireEvent.keyUp(allowOnce, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(allowOnce, { key: 'Enter', ctrlKey: true });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ decisionClassification: 'user_permanent' }),
    );
  });
});
