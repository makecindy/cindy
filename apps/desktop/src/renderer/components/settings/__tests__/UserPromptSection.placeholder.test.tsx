// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  state: { value: '', ready: true, unavailable: false, customized: false, revision: 'r1' as string | null, ownerKey: 'owner-a:1' },
  save: vi.fn(), reset: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useUserPrompt', () => ({ useUserPrompt: () => ({ value: fixture.state.value, setValue: fixture.save }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: fixture.success, error: fixture.error } }));
import appI18n from 'i18next';
import { UserPromptEditor, UserPromptSection } from '../UserPromptSection';
/** The editor as the cloud settings page drives it, with the instance's revision and reset. */
function HostEditor() {
  return <UserPromptEditor {...fixture.state} setValue={fixture.save} resetValue={fixture.reset} />;
}
const editor = () => screen.getByRole('textbox', { name: 'settings.personalization.ariaLabel' });
const saveButton = () => screen.getByRole('button', { name: 'settings.personalization.save' }) as HTMLButtonElement;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.state = { value: '', ready: true, unavailable: false, customized: false, revision: 'r1', ownerKey: 'owner-a:1' };
  fixture.save.mockResolvedValue(undefined); fixture.reset.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('云设置页的个性化编辑与保存回执', () => {
  it('保留原占位 token 与空白视觉处理', () => {
    render(<UserPromptSection />);
    expect(editor().className).toContain('placeholder:text-[var(--settings-input-placeholder)]');
    expect(editor().className).toContain('placeholder:font-normal');
    expect(editor().className).not.toMatch(/placeholder:opacity-/);
  });
  it('Host 保存完成前不显示成功，提交编辑时的 revision', async () => {
    let resolve!: () => void;
    fixture.save.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    render(<HostEditor />);
    fireEvent.change(editor(), { target: { value: 'draft' } }); fireEvent.click(saveButton());
    expect(fixture.save).toHaveBeenCalledWith('draft', 'r1'); expect(fixture.success).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
    resolve(); await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
  });
  it('保存失败显示失败反馈，不谎报成功', async () => {
    fixture.save.mockRejectedValueOnce(new Error('fixture failure'));
    render(<HostEditor />);
    fireEvent.change(editor(), { target: { value: 'draft' } }); fireEvent.click(saveButton());
    await waitFor(() => expect(fixture.error).toHaveBeenCalledWith('hostSettings.saveFailed'));
    expect(fixture.success).not.toHaveBeenCalled();
  });
  it('恢复默认调用 clear 入口，不把空串当 reset 写回', async () => {
    fixture.state = { ...fixture.state, value: 'custom', customized: true };
    render(<HostEditor />); fireEvent.click(screen.getByRole('button', { name: 'hostSettings.reset' }));
    await waitFor(() => expect(fixture.reset).toHaveBeenCalledWith('r1'));
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it('外部更新保留未保存草稿，禁止用新 revision 覆盖', () => {
    const ui = render(<HostEditor />);
    fireEvent.change(editor(), { target: { value: 'my draft' } });
    fixture.state = { ...fixture.state, value: 'external', revision: 'r2' }; ui.rerender(<HostEditor />);
    expect((editor() as HTMLTextAreaElement).value).toBe('my draft');
    expect(saveButton().disabled).toBe(true); expect(screen.getByRole('status').textContent).toBe('hostSettings.changed');
  });
  it('切换账号立即清除旧草稿', () => {
    const ui = render(<HostEditor />);
    fireEvent.change(editor(), { target: { value: 'old owner draft' } });
    fixture.state = { ...fixture.state, value: '', ownerKey: 'owner-b:2', revision: 'r2' }; ui.rerender(<HostEditor />);
    expect((editor() as HTMLTextAreaElement).value).toBe(''); expect(saveButton().disabled).toBe(true);
  });
  it('无法读取的设置不能编辑或保存，不把空白当真实默认值', () => {
    fixture.state = { ...fixture.state, ready: false, unavailable: true, revision: null };
    render(<HostEditor />);
    expect((editor() as HTMLTextAreaElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true); expect(screen.getByRole('status').textContent).toBe('hostSettings.loadFailed');
  });
});

describe('普通桌面沿用本机提示词', () => {
  beforeEach(() => { fixture.save.mockReturnValue(undefined); });
  it('只有保存按钮，保存即提示成功', async () => {
    render(<UserPromptSection />);
    expect(screen.queryByRole('button', { name: 'hostSettings.reset' })).toBeNull();
    fireEvent.change(editor(), { target: { value: 'draft' } }); fireEvent.click(saveButton());
    expect(fixture.save).toHaveBeenCalledWith('draft', 'local');
    await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
  });
  it('外部值变化时草稿跟随', () => {
    const view = render(<UserPromptSection />);
    fireEvent.change(editor(), { target: { value: 'draft' } });
    fixture.state = { ...fixture.state, value: 'other window' };
    view.rerender(<UserPromptSection />);
    expect((editor() as HTMLTextAreaElement).value).toBe('other window');
  });
});

it('updates the counter locale without changing the draft length', () => {
  const original = appI18n.language;
  try {
    appI18n.language = 'en';
    const view = render(<UserPromptSection />);
    const counter = () => view.container.querySelector('[aria-live="polite"]')!.textContent;
    const english = counter();
    appI18n.language = 'de';
    view.rerender(<UserPromptSection />);
    expect(counter()).not.toBe(english);
  } finally { appI18n.language = original; }
});
