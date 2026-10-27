/** @vitest-environment jsdom */
// Test value: the real ShareDialog must honor dismissal, PNG failure and native
// save cancellation. These regressions are not covered by the main IPC suite.
// Minimal inputs are a delayed PNG promise, a rejected conversion and canceled
// save; this unit tier renders jsdom and fakes only native/image boundaries.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  png: vi.fn(),
  copyImage: vi.fn(),
  copyText: vi.fn(),
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/rasterizeToImage', () => ({
  svgToPngBlob: io.png,
  copyPngBlobToClipboard: io.copyImage,
}));
vi.mock('@/lib/annotationBurnIn', () => ({
  blobToDataUrl: async () => 'data:image/png;base64,aA==',
}));
vi.mock('@/lib/toast', () => ({ toast: { success: io.success, error: io.error } }));
import { ShareDialog } from '../ShareDialog';
const material = {
  title: 'Public plugin',
  url: 'https://share.example.test/plugins/c123456789012345678901234',
  imageSvg: '<svg />',
};
const load = async () => material;
// Buttons exist while material is loading. Wait for the real action to become
// usable so a disabled click cannot skip the PNG failure/cancellation path.
async function clickReadyAction(name: string) {
  const button = await screen.findByRole<HTMLButtonElement>('button', { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => { fireEvent.click(button); });
}
beforeEach(() => {
  vi.clearAllMocks();
  io.copyText.mockResolvedValue(undefined);
  io.copyImage.mockResolvedValue(undefined);
  io.png.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  io.save.mockResolvedValue({ canceled: true });
  vi.stubGlobal('electronAPI', { copyTextToClipboard: io.copyText, saveMediaAs: io.save });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('manual sharing output', () => {
  it('does not copy a picture that finishes rendering after dismissal', async () => {
    let finish!: (blob: Blob) => void;
    io.png.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<ShareDialog load={load} onClose={onClose} />);
    await clickReadyAction('sharing.copyImage');
    expect(io.png).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'sharing.close' }));
    await act(async () => {
      finish(new Blob(['png']));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(io.copyImage).not.toHaveBeenCalled();
  });
  it('keeps the valid link usable after PNG generation fails', async () => {
    io.png.mockRejectedValueOnce(new Error('image unavailable'));
    render(<ShareDialog load={load} onClose={vi.fn()} />);
    await clickReadyAction('sharing.copyImage');
    await waitFor(() => expect(io.error).toHaveBeenCalledWith('sharing.copyImageFailed'));
    await clickReadyAction('sharing.copyLink');
    await waitFor(() => expect(io.copyText).toHaveBeenCalledWith({ text: material.url }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('does not report a canceled native save as saved or failed', async () => {
    render(<ShareDialog load={load} onClose={vi.fn()} />);
    await clickReadyAction('sharing.saveImage');
    await waitFor(() => expect(io.save).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'sharing.saveImage' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
  });
});
