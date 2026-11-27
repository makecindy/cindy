// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import { Input, Textarea } from '../input';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { SearchInput } from '../search-input';

function inputClass(): string {
  return (screen.getByRole('textbox') as HTMLInputElement).className;
}

describe('Input', () => {
  afterEach(cleanup);

  it('binds §4 fill / text / border / placeholder tokens and stays a pill', () => {
    render(<Input value="" onChange={() => {}} placeholder="hint" />);
    const cls = inputClass();
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('bg-[var(--surface-elevated)]');
    expect(cls).toContain('text-[var(--text-primary)]');
    expect(cls).toContain('placeholder:text-[var(--text-placeholder)]');
    expect(cls).toContain('border-[var(--border-default)]');
    expect(cls).toContain('focus:ring-[var(--focus-ring-soft)]');
    expect(cls).not.toContain('settings-input-placeholder');
  });

  it('keeps sm/md/lg at 32/36/40px', () => {
    const { rerender } = render(<Input value="" onChange={() => {}} size="sm" />);
    expect(inputClass()).toContain('h-8');
    rerender(<Input value="" onChange={() => {}} size="md" />);
    expect(inputClass()).toContain('h-9');
    rerender(<Input value="" onChange={() => {}} size="lg" />);
    expect(inputClass()).toContain('h-[var(--size-input-lg)]');
    expect(readFileSync(resolve(__dirname, '../../../styles/generated/tokens.css'), 'utf8')).toContain('--size-input-lg: 40px;');
  });

  it('keeps ivory as an explicit white-panel variant', () => {
    render(<Input value="" onChange={() => {}} surface="ivory" />);
    expect(inputClass()).toContain('bg-[var(--settings-input-bg)]');
    expect(inputClass()).not.toContain('bg-[var(--surface-elevated)]');
  });

  it('uses --error-* tokens in the error state', () => {
    render(<Input value="" onChange={() => {}} error />);
    const cls = inputClass();
    expect(cls).toContain('border-[var(--error-border)]');
    expect(cls).toContain('focus:border-[var(--error-fg)]');
  });

  it('masks secret fields and exposes a reveal control', () => {
    render(<Input value="secret" onChange={() => {}} secret />);
    const field = document.querySelector('input');
    expect(field?.getAttribute('type')).toBe('password');
    expect(screen.getByRole('button', { name: 'settings.apiKey.showKey' })).toBeTruthy();
  });

  it('forwards the legacy focus ref and aria label aliases', () => {
    const inputRef = createRef<HTMLInputElement>();
    render(<Input value="" onChange={() => {}} inputRef={inputRef} ariaLabel="Context window" />);
    const field = screen.getByRole('textbox');
    expect(inputRef.current).toBe(field);
    expect(field.getAttribute('aria-label')).toBe('Context window');
    expect(field.getAttribute('inputref')).toBeNull();
  });

  it('keeps caller inline style instead of silently dropping it', () => {
    render(
      <Input value="" onChange={() => {}} style={{ textAlign: 'center', width: 120 }} />,
    );
    const el = screen.getByRole('textbox') as HTMLInputElement;
    expect(el.style.textAlign).toBe('center');
    expect(el.style.width).toBe('120px');
    // 组件内置的文本选择样式仍在，未被调用方清空。
    expect(el.style.userSelect).toBe('text');
  });

  it('lets caller override the built-in userSelect when explicitly asked', () => {
    render(<Input value="" onChange={() => {}} style={{ userSelect: 'none' }} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).style.userSelect).toBe('none');
  });
});

describe('Textarea', () => {
  afterEach(cleanup);

  it('uses the 8px inner-control radius and --text-placeholder', () => {
    render(<Textarea value="" onChange={() => {}} placeholder="notes" />);
    const cls = screen.getByRole('textbox').className;
    expect(cls).toContain('rounded-lg');
    expect(cls).not.toContain('rounded-full');
    expect(cls).toContain('placeholder:text-[var(--text-placeholder)]');
    expect(cls).toContain('bg-[var(--surface-elevated)]');
  });

  it('keeps caller inline style on the same merge order as Input', () => {
    render(<Textarea value="" onChange={() => {}} style={{ textAlign: 'right' }} />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(el.style.textAlign).toBe('right');
    expect(el.style.userSelect).toBe('text');
  });
});

describe('Input 合同自证伪', () => {
  afterEach(cleanup);

  it('绑 Tier-1 slot，不再消费 settings 域 alias（focus 边框同理）', () => {
    render(<Input value="" onChange={() => {}} />);
    const cls = inputClass();
    for (const banned of [
      'var(--settings-input-border)',
      'var(--settings-input-text)',
      'var(--settings-input-placeholder)',
      'var(--settings-input-border-focus)',
    ]) {
      expect(cls, `不应再消费 ${banned}`).not.toContain(banned);
    }
    expect(cls).toContain('focus:border-[var(--text-tertiary-stone)]');
  });

  it('自证伪：断言机制能抓到 token 漂移', () => {
    render(<Input value="" onChange={() => {}} />);
    const cls = inputClass();
    // 装作有人把 border 改回域 alias：下面这条必须为假。
    expect(cls.includes('border-[var(--settings-input-border)]')).toBe(false);
    // 而现行绑定必须为真，证明检查不是恒假。
    expect(cls.includes('border-[var(--border-default)]')).toBe(true);
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：SearchInput 组件；读屏看到的角色 / 名称 / 组合框关系，调用方的
 *   键盘处理收到的按键（含输入法组字中的回车）和默认行为是否被组件吞掉。
 * - 规则依据：主人裁决 #1 / #2（2026-11-23），盘点 PR-4 要求迁移时组合框 ARIA、输入法组字、
 *   Esc 行为原样保留（DESIGN.md §4 Inputs & Forms · Search fields）。
 * - 现有覆盖缺口：各调用点的测试只按占位符或名称取输入框，不覆盖组件对 ARIA 和按键的透传。
 * - 最小失败输入：role="combobox" + aria-activedescendant，按 Escape 后 defaultPrevented 应为假。
 * - tier：unit（jsdom 渲染真实组件）。
 */
describe('SearchInput', () => {
  afterEach(cleanup);

  it('forwards combobox semantics, refs and every key to the caller untouched', () => {
    const ref = createRef<HTMLInputElement>();
    const keys: Array<{ key: string; composing: boolean; prevented: boolean }> = [];
    const onChange = vi.fn();
    render(
      <SearchInput
        inputRef={ref}
        value="ab"
        onChange={onChange}
        aria-label="Search settings"
        role="combobox"
        aria-expanded
        aria-controls="results"
        aria-activedescendant="result-1"
        data-settings-search-action="Search"
        onKeyDown={(event) =>
          keys.push({
            key: event.key,
            composing: event.nativeEvent.isComposing,
            prevented: event.defaultPrevented,
          })
        }
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Search settings' }) as HTMLInputElement;
    expect(ref.current).toBe(box);
    expect(box.getAttribute('aria-activedescendant')).toBe('result-1');
    expect(box.getAttribute('aria-controls')).toBe('results');
    expect(box.getAttribute('data-settings-search-action')).toBe('Search');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(keys).toEqual([
      { key: 'Enter', composing: true, prevented: false },
      { key: 'Escape', composing: false, prevented: false },
      { key: 'ArrowDown', composing: false, prevented: false },
    ]);
    fireEvent.change(box, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  it('stays a plain textbox whose search icon is hidden from assistive technology', () => {
    const { container } = render(
      <SearchInput surface="panel" value="" onChange={() => {}} aria-label="Find" autoFocus />,
    );
    const box = screen.getByRole('textbox', { name: 'Find' });
    expect(box.getAttribute('type')).toBe('text');
    expect(document.activeElement).toBe(box);
    const icon = container.querySelector('svg');
    expect(icon?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：SearchInput 组件内置的清空按钮；读屏能否找到「commonUi.clearSearch」
 *   按钮、点击后调用方收到的 onChange('') / onClear、焦点落点，以及按下与点击对外层的影响。
 * - 规则依据：主人裁决 2026-11-27「清空 X 要有，所有搜索框都要有」；DESIGN.md §4 Search fields
 *   （有内容时右侧清空是标配，disabled / readOnly 不显示，不改 Esc，不关所在浮层）。
 * - 现有覆盖缺口：之前只有设置搜索和文件筛选各自手写清空按钮，组件层没有这项行为。
 * - 最小失败输入：value="ab" 时找不到清空按钮；点击后焦点不回输入框；按下没有 preventDefault
 *   （输入框失焦，靠失焦收起的面板会被关掉）；点击冒泡到外层 onClick；Popover 被点关。
 * - tier：unit（jsdom 渲染真实组件与真实 Radix Popover）。
 */
describe('SearchInput clear button', () => {
  afterEach(cleanup);

  function Controlled({
    initial,
    onClear,
    disabled,
    readOnly,
  }: { initial: string; onClear?: () => void; disabled?: boolean; readOnly?: boolean }) {
    const [value, setValue] = useState(initial);
    return (
      <SearchInput value={value} onChange={setValue} onClear={onClear} disabled={disabled}
        readOnly={readOnly} aria-label="Find" />
    );
  }

  const clearButton = () => screen.queryByRole('button', { name: 'commonUi.clearSearch' });

  it('appears only while there is text, and clicking it empties the field and refocuses it', () => {
    const onClear = vi.fn();
    render(<Controlled initial="" onClear={onClear} />);
    const box = screen.getByRole('textbox', { name: 'Find' }) as HTMLInputElement;
    expect(clearButton()).toBeNull();

    fireEvent.change(box, { target: { value: 'ab' } });
    const button = clearButton()!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('type')).toBe('button');

    // 按下时阻止默认行为：输入框不失焦。
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(box.value).toBe('');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box);
    expect(clearButton()).toBeNull();
  });

  it('is not offered on a disabled or read-only field', () => {
    render(<Controlled initial="ab" disabled />);
    expect(clearButton()).toBeNull();
    cleanup();
    render(<Controlled initial="ab" readOnly />);
    expect(clearButton()).toBeNull();
  });

  it('keeps a surrounding popover open and does not reach outer click handlers', () => {
    const outerClick = vi.fn();
    function InPopover() {
      const [value, setValue] = useState('ab');
      const [open, setOpen] = useState(true);
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger>open</PopoverTrigger>
          <PopoverContent>
            <div role="presentation" onClick={outerClick}>
              <SearchInput surface="panel" autoFocus value={value} onChange={setValue} aria-label="Find" />
            </div>
          </PopoverContent>
        </Popover>
      );
    }
    render(<InPopover />);
    const button = clearButton()!;
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    fireEvent.pointerUp(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
    const box = screen.getByRole('textbox', { name: 'Find' }) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('sits beside caller trailing content instead of replacing it', () => {
    render(
      <SearchInput value="ab" onChange={() => {}} aria-label="Find"
        trailing={<button type="button">Aa</button>} />,
    );
    expect(clearButton()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Aa' })).not.toBeNull();
  });
});
