// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import { Input, Textarea } from '../input';

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
    expect(cls).toContain('focus:ring-[var(--focus-ring)]');
    expect(cls).not.toContain('settings-input-placeholder');
  });

  it('keeps sm/md/lg at 32/36/40px', () => {
    const { rerender } = render(<Input value="" onChange={() => {}} size="sm" />);
    expect(inputClass()).toContain('h-8');
    rerender(<Input value="" onChange={() => {}} size="md" />);
    expect(inputClass()).toContain('h-9');
    rerender(<Input value="" onChange={() => {}} size="lg" />);
    expect(inputClass()).toContain('h-[40px]');
  });

  it('keeps ivory as an explicit registered-debt variant', () => {
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
