// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvatarCrop } from '../avatarCropGeometry';
import type { AvatarSource } from '../avatarCropImage';

const image = vi.hoisted(() => ({
  loadAvatarSource: vi.fn(),
  exportAvatarCrop: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
vi.mock('../avatarCropImage', () => image);

import { ProfileEditDialog } from '../ProfileEditDialog';

const EXPORTED = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);

function makeSource(width = 1200, height = 800): AvatarSource {
  return {
    bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap,
    size: { width, height },
  };
}

const api = {
  profileGetState: vi.fn(),
  profileChooseAvatar: vi.fn(),
  profileUpdate: vi.fn(),
};

function renderDialog() {
  const onOpenChange = vi.fn();
  const view = render(<ProfileEditDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, ...view };
}

async function chooseImage() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' }),
  );
  return screen.findByRole('group', { name: 'settings.userProfile.edit.crop.stageLabel' });
}

let source: AvatarSource;
let objectUrlCount = 0;

beforeEach(() => {
  source = makeSource();
  objectUrlCount = 0;
  api.profileGetState.mockResolvedValue({ name: 'Dash', avatarUrl: 'https://cdn.example/old.png' });
  api.profileChooseAvatar.mockResolvedValue({
    canceled: false,
    previewDataUrl: 'data:image/jpeg;base64,AAAA',
  });
  api.profileUpdate.mockResolvedValue({ ok: true });
  image.loadAvatarSource.mockImplementation(async () => source);
  image.exportAvatarCrop.mockImplementation(async () => ({
    blob: new Blob([EXPORTED], { type: 'image/jpeg' }),
    bytes: EXPORTED,
    mimeType: 'image/jpeg',
  }));
  Object.assign(window, { electronAPI: api });
  URL.createObjectURL = vi.fn(() => `blob:avatar-${++objectUrlCount}`);
  URL.revokeObjectURL = vi.fn();
  // jsdom 不做布局:给编辑台一个真实尺寸,否则取景圆直径为 0,平移 / 缩放全是 no-op。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 368,
    bottom: 288,
    width: 368,
    height: 288,
    toJSON: () => ({}),
  } as DOMRect);
  // Radix Slider 量尺寸用 ResizeObserver,jsdom 没有。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ProfileEditDialog 头像调整', () => {
  // Regression: a group editor must never load or save the global account profile.
  // Existing crop tests cover only account editing; this exercises the same real
  // dialog with a group-scoped destination (unit/jsdom).
  it('saves a cropped group avatar without reading or writing the account profile', async () => {
    const avatarEditor = {
      title: 'Group avatar', hint: 'Only this group',
      getState: vi.fn(async () => ({ name: 'Group me', avatarUrl: 'https://example.com/group.png', defaultAvatarUrl: 'https://example.com/account.png' })),
      save: vi.fn(async () => {}),
    };
    render(<ProfileEditDialog open onOpenChange={vi.fn()} avatarEditor={avatarEditor} />);
    await screen.findByText('Group avatar');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.profileGetState).not.toHaveBeenCalled();
    await chooseImage();
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(avatarEditor.save).toHaveBeenCalledWith({ type: 'set', data: EXPORTED, mimeType: 'image/jpeg' }));
    expect(api.profileUpdate).not.toHaveBeenCalled();
  });

  // Review regression (unit/jsdom): existing group tests never refreshed member
  // metadata mid-edit. A new nickname must not discard the crop or saved draft.
  it.each(['cropping', 'preview'] as const)('preserves the group avatar during %s when member metadata refreshes', async (step) => {
    const onOpenChange = vi.fn();
    const save = vi.fn(async () => {});
    const editor = (name: string) => ({
      title: 'Group avatar', hint: 'Only this group', save,
      getState: async () => ({ name, avatarUrl: 'https://example.com/group.png', defaultAvatarUrl: null }),
    });
    const view = render(<ProfileEditDialog open onOpenChange={onOpenChange} avatarEditor={editor('Before')} />);
    await chooseImage();
    if (step === 'preview') {
      fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
      await screen.findByRole('button', { name: 'settings.userProfile.edit.save' });
    }

    const refreshed = editor('After');
    view.rerender(<ProfileEditDialog open onOpenChange={onOpenChange} avatarEditor={refreshed} />);
    await act(async () => {});
    expect(source.bitmap.close).not.toHaveBeenCalled();
    if (step === 'cropping') {
      expect(screen.getByRole('group', { name: 'settings.userProfile.edit.crop.stageLabel' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
      await screen.findByRole('button', { name: 'settings.userProfile.edit.save' });
    }
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('blob:avatar-1');
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ type: 'set', data: EXPORTED, mimeType: 'image/jpeg' }));
    expect(api.profileUpdate).not.toHaveBeenCalled();

    // Closing still releases the draft; reopening starts with server data.
    view.rerender(<ProfileEditDialog open={false} onOpenChange={onOpenChange} avatarEditor={refreshed} />);
    expect(source.bitmap.close).toHaveBeenCalledTimes(1);
    view.rerender(<ProfileEditDialog open onOpenChange={onOpenChange} avatarEditor={refreshed} />);
    await act(async () => {});
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('https://example.com/group.png');
  });

  it('previews the account avatar on group reset and keeps the editor open if saving fails', async () => {
    const onOpenChange = vi.fn();
    const avatarEditor = {
      title: 'Group avatar', hint: 'Only this group',
      getState: async () => ({ name: 'Group me', avatarUrl: 'https://example.com/group.png', defaultAvatarUrl: 'https://example.com/account.png' }),
      save: vi.fn(async () => { throw new Error('REQUEST_FAILED'); }),
    };
    render(<ProfileEditDialog open onOpenChange={onOpenChange} avatarEditor={avatarEditor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.userProfile.edit.resetAvatar' }));
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('https://example.com/account.png');
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('settings.userProfile.edit.saveFailed'));
    expect(avatarEditor.save).toHaveBeenCalledWith({ type: 'reset' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(api.profileUpdate).not.toHaveBeenCalled();
  });

  it('选图后进入调整步骤;取消回到表单且不改旧头像,保存不上传', async () => {
    const { onOpenChange } = renderDialog();
    await chooseImage();
    expect(screen.getByText('settings.userProfile.edit.crop.title')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.cancel' }));

    await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(image.exportAvatarCrop).not.toHaveBeenCalled();
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('https://cdn.example/old.png');
    // 新选的源没有被草稿接管,取消时立即释放。
    expect(source.bitmap.close).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(api.profileUpdate).toHaveBeenCalledTimes(1));
    expect(api.profileUpdate).toHaveBeenCalledWith({ name: 'Dash', avatar: { type: 'keep' } });
  });

  it('调整步骤里 Esc 只回到表单,不关闭弹窗', async () => {
    const { onOpenChange } = renderDialog();
    const stage = await chooseImage();
    fireEvent.keyDown(stage, { key: 'Escape' });
    await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('键盘平移 / 缩放后「完成」:导出当时的取景,预览即导出字节,保存上传同一份字节', async () => {
    const { onOpenChange } = renderDialog();
    const stage = await chooseImage();
    // 横图铺满时可左右移动;放大后上下也能移动。
    fireEvent.keyDown(stage, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(stage, { key: '+' });

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));

    await screen.findByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(image.exportAvatarCrop).toHaveBeenCalledTimes(1);
    const [exportedFrom, crop] = image.exportAvatarCrop.mock.calls[0] as [AvatarSource, AvatarCrop];
    expect(exportedFrom).toBe(source);
    expect(crop.side).toBeCloseTo(800 / 1.2, 9);
    expect(crop.cx).toBeLessThan(600);
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('blob:avatar-1');

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.profileUpdate).toHaveBeenCalledWith({
      name: 'Dash',
      avatar: { type: 'set', data: EXPORTED, mimeType: 'image/jpeg' },
    });
  });

  it('保存失败保留调整结果,可继续调整(沿用上次构图)或直接重试', async () => {
    const { onOpenChange } = renderDialog();
    const stage = await chooseImage();
    fireEvent.keyDown(stage, { key: '+' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    await screen.findByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' });
    const firstCrop = image.exportAvatarCrop.mock.calls[0]?.[1] as AvatarCrop;

    api.profileUpdate.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('settings.userProfile.edit.saveFailed'),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((screen.getByRole('img') as HTMLImageElement).src).toBe('blob:avatar-1');
    expect(source.bitmap.close).not.toHaveBeenCalled();

    // 再次调整:回到上次的取景,而不是重新居中。
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' }));
    await screen.findByRole('group', { name: 'settings.userProfile.edit.crop.stageLabel' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    await screen.findByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' });
    expect(image.exportAvatarCrop.mock.calls[1]?.[1]).toEqual(firstCrop);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1');

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.save' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.profileUpdate).toHaveBeenCalledTimes(2);
  });

  it('解码失败留在表单并提示;导出失败留在调整步骤并提示', async () => {
    renderDialog();
    image.loadAvatarSource.mockRejectedValueOnce(new Error('corrupt'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('settings.userProfile.edit.avatarInvalid'),
    );
    expect(screen.queryByRole('group')).toBeNull();

    await chooseImage();
    image.exportAvatarCrop.mockRejectedValueOnce(new Error('encode'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    });
    expect(toastError).toHaveBeenCalledWith('settings.userProfile.edit.crop.exportFailed');
    expect(
      screen.getByRole('group', { name: 'settings.userProfile.edit.crop.stageLabel' }),
    ).toBeTruthy();
  });

  it('重新选图从新图的居中铺满开始,替换旧草稿并释放旧位图', async () => {
    renderDialog();
    const stage = await chooseImage();
    fireEvent.keyDown(stage, { key: '+' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    await screen.findByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' });
    const first = source;

    source = makeSource(600, 900);
    await chooseImage();
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    await screen.findByRole('button', { name: 'settings.userProfile.edit.adjustAvatar' });

    expect(image.exportAvatarCrop.mock.calls[1]).toEqual([source, { cx: 300, cy: 450, side: 600 }]);
    expect(first.bitmap.close).toHaveBeenCalled();
    expect(source.bitmap.close).not.toHaveBeenCalled();
  });

  it('选图解码期间关闭再重开:旧请求作废,不把已放弃的图片带回调整步骤并释放其位图', async () => {
    let resolveDecode: (value: AvatarSource) => void = () => {};
    image.loadAvatarSource.mockImplementationOnce(
      () => new Promise<AvatarSource>((resolve) => (resolveDecode = resolve)),
    );
    const { rerender } = renderDialog();
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' }),
    );
    await waitFor(() => expect(image.loadAvatarSource).toHaveBeenCalledTimes(1));

    rerender(<ProfileEditDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<ProfileEditDialog open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' });

    const stale = makeSource();
    await act(async () => resolveDecode(stale));

    expect(screen.queryByRole('group')).toBeNull();
    expect(stale.bitmap.close).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    // 新一轮打开可以正常选图,不被旧请求的守卫挡住。
    await chooseImage();
  });

  it('选图解码期间卸载:返回的位图被释放,不进入调整步骤', async () => {
    let resolveDecode: (value: AvatarSource) => void = () => {};
    image.loadAvatarSource.mockImplementationOnce(
      () => new Promise<AvatarSource>((resolve) => (resolveDecode = resolve)),
    );
    const { unmount } = renderDialog();
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.userProfile.edit.changeAvatar' }),
    );
    await waitFor(() => expect(image.loadAvatarSource).toHaveBeenCalledTimes(1));
    unmount();
    const stale = makeSource();
    await act(async () => resolveDecode(stale));
    expect(stale.bitmap.close).toHaveBeenCalled();
  });
});
