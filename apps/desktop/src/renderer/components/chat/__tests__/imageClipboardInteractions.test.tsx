// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '@/components/ui/tooltip';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { AssistantMessage } from '../AssistantMessage';
import { ChatImageView } from '../ChatImageView';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ImageLightbox } from '../ImageLightbox';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { parseRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const managed = `cindy-media://blobs/${'a'.repeat(64)}.png`;
// Logical remote paths and xdt-file URLs are platform-independent protocol values.
const localFile = 'xdt-file://local/?path=%2Ffixture%2Fpreview.png';
const nativeCopy = vi.fn();
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
const fileCopy = vi.fn();
const readBytes = vi.fn();
const reveal = vi.fn();
const webCopy = vi.fn();
const writeText = vi.fn();
const save = vi.fn();
const open = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fileCopy.mockResolvedValue({ success: true });
  nativeCopy.mockResolvedValue(undefined);
  readBytes.mockResolvedValue({ base64: PNG, mimeType: 'image/png' });
  reveal.mockResolvedValue({ success: true });
  save.mockResolvedValue({ canceled: false });
  open.mockResolvedValue(undefined);
  webCopy.mockRejectedValue(new Error('Document is not focused'));
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly items: Record<string, Blob>) {}
    },
  );
  vi.stubGlobal('electronAPI', {
    copyMediaToClipboard: fileCopy,
    copyPngToClipboard: nativeCopy,
    readImageBytes: readBytes,
    readCachedImageAsBase64: readBytes,
    showItemInFolder: reveal,
    saveMediaAs: save,
    openMediaWithDefaultApp: open,
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: webCopy, writeText },
  });
  vi.spyOn(toast, 'success').mockImplementation(() => 'ok');
  vi.spyOn(toast, 'error').mockImplementation(() => 'error');
  // JSDOM lacks image/canvas decoding. Keep production source loading, menu,
  // encoding orchestration and clipboard bridge; isolate only the bitmap platform.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    const png = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));
    callback({ arrayBuffer: async () => png.buffer } as Blob);
  });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  await i18n.changeLanguage('en');
});

const label = (key: string) => i18n.t(key);
async function copyFromMenu(image: HTMLElement) {
  fireEvent.contextMenu(image, { clientX: 30, clientY: 40 });
  fireEvent.click(await screen.findByRole('menuitem', { name: label('chat.media.copyImage') }));
}

describe('shared production image interactions', () => {
  it.each([false, true])(
    'assistant local Markdown image menu, simplified=%s',
    async (simplified) => {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <ConfirmDialogProvider>
              <AssistantMessage
                workingDir="/fixture"
                content="![preview](/fixture/preview.png)"
                simplifiedBotConversation={simplified}
                showActionBar
              />
            </ConfirmDialogProvider>
          </Tooltip.Provider>
        </MemoryRouter>,
      );
      const img = screen.getByAltText('preview');
      await copyFromMenu(img);
      await waitFor(() =>
        expect(fileCopy).toHaveBeenCalledWith({ filePath: '/fixture/preview.png' }),
      );
      expect(toast.success).toHaveBeenCalledWith(label('chat.media.imageCopied'));
      // The message toolbar copies Markdown text, never the image or its path.
      fireEvent.click(screen.getByRole('button', { name: label('chat.messageActionBar.copy') }));
      expect(writeText).toHaveBeenCalledWith('![preview](/fixture/preview.png)');
      expect(nativeCopy).not.toHaveBeenCalled();
    },
  );

  it.each(['user-attached', 'tool-output'] as const)(
    'preserves managed file copy and reveal for %s',
    async (variant) => {
      render(<ChatImageView src={managed} filename="preview" variant={variant} />);
      await copyFromMenu(screen.getByAltText('preview'));
      await waitFor(() => expect(fileCopy).toHaveBeenCalledWith({ url: managed }));
      fireEvent.contextMenu(screen.getByAltText('preview'));
      fireEvent.click(
        await screen.findByRole('menuitem', { name: label('chat.media.revealImage') }),
      );
      await waitFor(() => expect(reveal).toHaveBeenCalledWith({ url: managed }));
    },
  );

  it.each([`data:image/png;base64,${PNG}`, 'https://images.example.test/preview.png'])(
    'copies reachable inline thumbnail without browser clipboard: %s',
    async (src) => {
      render(<ChatImageView src={src} filename="preview" variant="tool-output" />);
      fireEvent.contextMenu(screen.getByAltText('preview'));
      expect(screen.queryByRole('menuitem', { name: label('chat.media.revealImage') })).toBeNull();
      fireEvent.click(await screen.findByRole('menuitem', { name: label('chat.media.copyImage') }));
      await waitFor(() => expect(nativeCopy).toHaveBeenCalled());
      expect(new Uint8Array(nativeCopy.mock.calls[0][0].png)).toEqual(
        Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
      );
      expect(webCopy).not.toHaveBeenCalled();
      expect(fileCopy).not.toHaveBeenCalled();
      if (src.startsWith('https:')) expect(readBytes).toHaveBeenCalledWith({ url: src });
    },
  );

  it.each([
    { kind: 'device' as const, deviceId: 'fixture-device' },
    { kind: 'ssh' as const, remoteHostId: 'fixture-ssh' },
  ])('preserves $kind source through thumbnail and preview copy/save/open', async (origin) => {
    render(
      <ChatSessionFileProvider
        value={{ sessionId: 'fixture-session', workingDir: '/fixture', origin }}
      >
        <ChatImageView
          src={localFile}
          sessionId="fixture-session"
          filename="preview"
          variant="tool-output"
        />
      </ChatSessionFileProvider>,
    );
    const img = screen.getByAltText('preview');
    const remoteSrc = img.getAttribute('src')!;
    expect(parseRemoteMediaUrl(remoteSrc)?.origin).toEqual(
      origin.kind === 'ssh' ? { ...origin, workdir: '/fixture' } : origin,
    );
    await copyFromMenu(img);
    await waitFor(() => expect(nativeCopy).toHaveBeenCalledTimes(1));
    expect(readBytes).toHaveBeenCalledWith({ url: remoteSrc });
    fireEvent.click(img);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: label('chat.media.copyImage') })),
    );
    expect(nativeCopy).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: label('chat.media.saveAs') }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ url: remoteSrc }));
    fireEvent.click(screen.getByRole('button', { name: label('chat.media.openWithApp') }));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ url: remoteSrc }));
    expect(fileCopy).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(webCopy).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
    'localizes typed native clipboard failure in %s',
    async (locale) => {
      await i18n.changeLanguage(locale);
      nativeCopy.mockRejectedValue(new Error('[INTERNAL] secret/path must not appear'));
      render(<ImageLightbox src={`data:image/png;base64,${PNG}`} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: label('chat.media.copyImage') }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(label('ipcError.INTERNAL')));
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it('burns local image annotations before copying the PNG instead of the source file', async () => {
    const ctx = {
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(100);
    render(
      <ImageLightbox
        src={managed}
        initialStrokes={[{ points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.5 }] }]}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: label('chat.media.copyImage') }));
    await waitFor(() => expect(nativeCopy).toHaveBeenCalledTimes(1));
    expect(readBytes).toHaveBeenCalledWith({ url: managed });
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledWith(20, 20);
    expect(ctx.lineTo).toHaveBeenCalledWith(100, 50);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.stroke.mock.invocationCallOrder[1]).toBeLessThan(
      nativeCopy.mock.invocationCallOrder[0],
    );
    expect(fileCopy).not.toHaveBeenCalled();
    expect(webCopy).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(label('chat.media.imageCopied'));
  });

  it.each(['returned', 'thrown'])(
    'reports local copy %s failures instead of an unhandled rejection',
    async (failure) => {
      if (failure === 'returned')
        fileCopy.mockResolvedValue({ success: false, error: 'private/path' });
      else fileCopy.mockRejectedValue(new Error('private/path'));
      render(<ChatImageView src={managed} filename="preview" variant="tool-output" />);
      await copyFromMenu(screen.getByAltText('preview'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(label('chat.media.copyFailed')));
      expect(toast.success).not.toHaveBeenCalled();
    },
  );
  it('keeps remote Markdown ownership in the inline menu', async () => {
    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 's1',
          workingDir: '/fixture',
          origin: { kind: 'device', deviceId: 'other-host' },
        }}
      >
        <MarkdownRenderer
          workingDir="/fixture"
          currentSessionId="s1"
          content={`![preview](${managed})`}
        />
      </ChatSessionFileProvider>,
    );
    const img = screen.getByAltText('preview');
    const remoteSrc = img.getAttribute('src')!;
    expect(parseRemoteMediaUrl(remoteSrc)?.origUrl).toBe(managed);
    await copyFromMenu(img);
    await waitFor(() => expect(nativeCopy).toHaveBeenCalled());
    expect(readBytes).toHaveBeenCalledWith({ url: remoteSrc });
    expect(fileCopy).not.toHaveBeenCalled();
  });

  it('does not fall back to a local path when remote reading is denied', async () => {
    readBytes.mockRejectedValue(new Error('[PERMISSION_DENIED] hidden origin'));
    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 's1',
          workingDir: '/fixture',
          origin: { kind: 'device', deviceId: 'other-host' },
        }}
      >
        <ChatImageView src={localFile} sessionId="s1" filename="preview" variant="tool-output" />
      </ChatSessionFileProvider>,
    );
    await copyFromMenu(screen.getByAltText('preview'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(label('ipcError.PERMISSION_DENIED')),
    );
    expect(fileCopy).not.toHaveBeenCalled();
    expect(nativeCopy).not.toHaveBeenCalled();
    expect(webCopy).not.toHaveBeenCalled();
  });

  it('retains the existing browser copy path for images beyond native export limits', async () => {
    const png = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));
    new DataView(png.buffer).setUint32(16, 5000);
    new DataView(png.buffer).setUint32(20, 5000);
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((callback) => {
      callback({ arrayBuffer: async () => png.buffer } as Blob);
    });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(readonly items: Record<string, Blob>) {}
      },
    );
    webCopy.mockResolvedValue(undefined);
    render(<ImageLightbox src={`data:image/png;base64,${PNG}`} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: label('chat.media.copyImage') }));
    await waitFor(() => expect(webCopy).toHaveBeenCalledTimes(1));
    expect(nativeCopy).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(label('chat.media.imageCopied'));
  });

  it('keeps unsupported blob URLs out of file-copy actions', () => {
    render(<ChatImageView src="blob:opaque-fixture" filename="preview" variant="tool-output" />);
    fireEvent.contextMenu(screen.getByAltText('preview'));
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(fileCopy).not.toHaveBeenCalled();
  });
});
