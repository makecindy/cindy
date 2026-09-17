// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_PORTRAIT_COUNT, BotPortraitPicker, galleryPortrait } from '../BotPortraitPicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { number: number }) => (options ? `${key}-${options.number}` : key),
  }),
}));
const drawImage = vi.fn();
const decode = vi.fn(async () => {});
beforeEach(() => {
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
    const onUpload = vi.fn();
    render(<BotPortraitPicker value="existing.png" onChange={onChange} onUpload={onUpload} />);
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
    expect(onUpload).toHaveBeenCalledOnce();
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
    decode.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const onChange = vi.fn();
    const onUpload = vi.fn();
    render(<BotPortraitPicker onChange={onChange} onUpload={onUpload} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.upload' }));
    await act(async () => complete());
    expect(onUpload).toHaveBeenCalledOnce();
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
