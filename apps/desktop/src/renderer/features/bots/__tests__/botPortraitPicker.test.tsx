// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAvatar } from '../BotAvatar';
import { BOT_PORTRAIT_COUNT, BotPortraitPicker, galleryPortrait } from '../BotPortraitPicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { number: number }) => (options ? `${key}-${options.number}` : key),
  }),
}));
const chooseAvatar = vi.fn();
const drawImage = vi.fn();
const decode = vi.fn(async () => {});
beforeEach(() => {
  chooseAvatar.mockReset().mockResolvedValue({ canceled: true });
  vi.stubGlobal('electronAPI', {
    profileChooseAvatar: vi.fn(() => { throw new Error('Account service is unavailable in local mode'); }),
    localDb: { bots: { chooseAvatarSource: chooseAvatar } },
  });
  drawImage.mockClear();
  decode.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      width = 1024;
      height = 1024;
      decode = decode;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,cG9ydHJhaXQ=',
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared teammate portrait gallery', () => {
  it('offers Cindy first, all existing portraits next and upload last', () => {
    const onChange = vi.fn();

    render(<BotPortraitPicker value="existing.png" onChange={onChange} />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('existing.png');
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
    expect(buttons).toHaveLength(18);
    expect(buttons[0].getAttribute('aria-label')).toBe('Cindy');
    expect(buttons.slice(1, 17).map((button) => button.getAttribute('aria-label'))).toEqual(
      Array.from({ length: 16 }, (_, i) => `bots.guided.portrait-${i + 1}`),
    );
    expect(buttons[17].getAttribute('aria-label')).toBe('bots.guided.upload');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(buttons[17]);
    expect(chooseAvatar).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns image bytes when Cindy is explicitly selected', async () => {
    const onChange = vi.fn();
    render(<BotPortraitPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith('data:image/png;base64,cG9ydHJhaXQ='),
    );
    expect(drawImage.mock.calls[0][0].src).toContain('cindy.png');
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1024, 1024, 0, 0, 256, 256]);
  });

  it.each([1, 4, 5, 16])('keeps the old sheet coordinates for gallery choice %i', async (index) => {
    await galleryPortrait(index);
    const cell = index - 1;
    expect(drawImage.mock.calls[0][0].src).toContain('teammate-portrait-gallery.png');
    expect(drawImage.mock.calls[0].slice(1)).toEqual([
      (cell % 4) * 256,
      Math.floor(cell / 4) * 256,
      256,
      256,
      0,
      0,
      256,
      256,
    ]);
  });

  it.each([-1, BOT_PORTRAIT_COUNT, 0.5])('rejects invalid gallery index %i', async (index) => {
    await expect(galleryPortrait(index)).rejects.toThrow('Unknown portrait');
  });

  it('lets the upload action supersede an earlier pending gallery selection', async () => {
    let complete!: () => void;
    decode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const onChange = vi.fn();

    render(<BotPortraitPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
    await act(async () => complete());
    expect(chooseAvatar).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not apply a late image selection after leaving the picker', async () => {
    let complete!: () => void;
    decode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const onChange = vi.fn();
    const view = render(<BotPortraitPicker onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    view.unmount();
    await act(async () => complete());
    expect(onChange).not.toHaveBeenCalled();
  });
});

it.each(['cindy://avatar/preset/cindy', '🤖', '👩🏽‍💻'])(
  'renders a current avatar fallback while prioritizing a new image draft: %s',
  (avatar) => {
    const fallback = <BotAvatar bot={{ name: 'Cindy', avatar }} />;
    const view = render(<BotPortraitPicker fallback={fallback} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'bots.profile.changeAvatar' });
    if (avatar.startsWith('cindy://'))
      expect(trigger.querySelector('img')?.getAttribute('src')).toContain('cindy.png');
    else expect(trigger.textContent).toContain(avatar);
    view.rerender(
      <BotPortraitPicker
        value="data:image/jpeg;base64,/9j/2Q=="
        fallback={fallback}
        onChange={vi.fn()}
      />,
    );
    expect(trigger.querySelectorAll('img')).toHaveLength(1);
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,/9j/2Q==',
    );
    expect(trigger.textContent).not.toContain(avatar);
  },
);

it.each(['error', 'cancel', 'unmount'])(
  'releases native image preparation on %s without accepting a portrait',
  async (outcome) => {
    let resolve!: (result: { canceled: boolean }) => void;
    chooseAvatar.mockImplementationOnce(() =>
      outcome === 'error'
        ? Promise.reject(new Error('HDR conversion failed'))
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const pending = vi.fn();
    const onChange = vi.fn();
    const view = render(<BotPortraitPicker onChange={onChange} onPreparingChange={pending} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
    if (outcome === 'unmount') view.unmount();
    await act(async () => {
      if (outcome !== 'error') resolve({ canceled: true });
    });
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(onChange).not.toHaveBeenCalled();
  },
);

it('keeps the newer gallery operation pending when an older decode settles', async () => {
  const decodes: Array<() => void> = [];
  decode.mockImplementation(() => new Promise<void>((resolve) => decodes.push(resolve)));
  const pending = vi.fn();
  const onChange = vi.fn();
  render(<BotPortraitPicker onChange={onChange} onPreparingChange={pending} />);
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.guided.portrait-1' }));
  await act(async () => decodes[0]());
  expect(pending.mock.calls).toEqual([[true]]);
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => decodes[1]());
  expect(pending.mock.calls).toEqual([[true], [false]]);
  expect(onChange).toHaveBeenCalledOnce();
});

it('releases preparation after a gallery decode failure', async () => {
  decode.mockRejectedValueOnce(new Error('decode failed'));
  const pending = vi.fn();
  const onChange = vi.fn();
  render(<BotPortraitPicker onChange={onChange} onPreparingChange={pending} />);
  fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
  expect(pending).toHaveBeenNthCalledWith(1, true);
  await screen.findByRole('alert');
  expect(pending.mock.calls).toEqual([[true], [false]]);
  expect(onChange).not.toHaveBeenCalled();
});

// Unit: the production picker must gate uploaded bytes on crop confirmation.
// Gallery tests did not cover this boundary; minimal input is one non-square PNG.
const cropIO = vi.hoisted(() => ({ load: vi.fn(), export: vi.fn() }));
vi.mock('@/components/settings/avatarCropImage', () => ({
  loadAvatarSource: cropIO.load,
  exportAvatarCrop: cropIO.export,
}));

describe('custom portrait crop confirmation', () => {
  let closeBitmap: ReturnType<typeof vi.fn>;
  const upload = () => {
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
  };
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    chooseAvatar.mockResolvedValue({
      canceled: false,
      previewDataUrl: 'data:image/png;base64,c2Ry',
    });
    closeBitmap = vi.fn();
    cropIO.load.mockReset().mockResolvedValue({
      bitmap: { close: closeBitmap },
      size: { width: 800, height: 400 },
    });
    cropIO.export.mockReset().mockResolvedValue({ blob: new Blob(['cropped']) });
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,Y3JvcHBlZA==';
        onload = () => {};
        readAsDataURL() {
          this.onload();
        }
      },
    );
  });

  it('uses the host-prepared SDR source before decoding a custom upload', async () => {
    render(<BotPortraitPicker onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
    await waitFor(() => expect(cropIO.load).toHaveBeenCalledWith('data:image/png;base64,c2Ry'));
    expect(chooseAvatar).toHaveBeenCalledOnce();
  });

  it('retains the old avatar until Done and submits exported bytes', async () => {
    const onChange = vi.fn();
    render(<BotPortraitPicker value="old.png" onChange={onChange} />);
    upload();
    await screen.findByRole('alertdialog');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('old.png');
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.crop.done' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,Y3JvcHBlZA=='),
    );
    expect(cropIO.export.mock.calls[0][1]).toEqual({ cx: 400, cy: 200, side: 400 });
    expect(closeBitmap).toHaveBeenCalledOnce();
  });

  it('cancels without changing the avatar and permits selecting the same file again', async () => {
    const onChange = vi.fn();
    render(<BotPortraitPicker value="old.png" onChange={onChange} />);
    upload();
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.edit.cancel' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(closeBitmap).toHaveBeenCalledOnce();
    upload();
    await screen.findByRole('alertdialog');
    expect(cropIO.load).toHaveBeenCalledTimes(2);
  });

  it('rejects a corrupt image and releases the navigation guard', async () => {
    cropIO.load.mockRejectedValueOnce(new Error('Invalid image'));
    const onChange = vi.fn();
    const pending = vi.fn();
    render(<BotPortraitPicker onChange={onChange} onPreparingChange={pending} />);
    upload();
    await screen.findByRole('alert');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });

  it('discards a decoded upload after the picker unmounts', async () => {
    let resolve!: (source: unknown) => void;
    cropIO.load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onChange = vi.fn();
    const view = render(<BotPortraitPicker onChange={onChange} />);
    upload();
    await act(async () => {});
    view.unmount();
    await act(async () =>
      resolve({ bitmap: { close: closeBitmap }, size: { width: 800, height: 400 } }),
    );
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
