// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import { openBrowserAsync } from 'expo-web-browser';
import { writeClipboardText } from '@/session/messageActions';
import { withDownloadedRemoteMediaFile } from '@/session/remoteMediaDiskCacheExpo';
import {
  BotGroupTextAttachmentPreview,
  botGroupTextAttachmentPreviewKind,
} from '@/session/BotGroupTextAttachmentPreview';

const downloadState = vi.hoisted(() => ({ text: '', tooLargeCount: 0, failedCount: 0 }));
const nativeList = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ withDownloadedRemoteMediaFile: vi.fn() }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['ExternalLink','X','Copy','Search','WrapText','ListOrdered','ChevronLeft','ChevronRight','Ellipsis'].map(key => [key, () => null])));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (make: any) => make(tokens.lightColors) };
});
vi.mock('@legendapp/list/react-native', async () => ({ LegendList: (await import('react-native')).FlatList }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: vi.fn().mockResolvedValue(undefined) }));
vi.mock('expo-file-system', () => ({ File: class {} }));
vi.mock('expo-sharing', () => ({ shareAsync: vi.fn() }));
vi.mock('@/session/DiagramDocumentPreview', () => ({ DiagramDocumentPreview: () => null }));
vi.mock('@/session/SheetModal', () => ({ SheetModal: ({ visible, children }: any) => visible ? children : null }));
vi.mock('@/components/AppText', async () => {
  const React = await import('react');
  return {
    Text: ({ children, testID }: any) => React.createElement('span', { 'data-testid': testID }, children),
    TextInput: (await import('react-native')).TextInput,
  };
});
vi.mock('@/session/HtmlFileReader', async () => {
  const React = await import('react');
  return {
    HtmlFileReader: ({ html, javaScriptEnabled, testID }: any) => React.createElement('div', {
      'data-testid': testID,
      'data-javascript-enabled': String(javaScriptEnabled),
    }, html),
  };
});
vi.mock('@/session/MarkdownFileReader', async () => {
  const React = await import('react');
  return {
    MarkdownFileReader: ({ markdown, imageSources, testID }: any) => React.createElement('div', {
      'data-testid': testID,
      'data-image-source-count': String(imageSources?.size ?? 'missing'),
    }, markdown),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const React = await import('react');
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: any) => React.createElement('div', null, children),
    SafeAreaView: ({ children }: any) => React.createElement('div', null, children),
  };
});
vi.mock('react-native', async () => {
  const React = await import('react');
  const render = (tag: string) => ({ children, testID, accessibilityLabel, onPress, onChangeText, value }: any) => React.createElement(tag, {
    'data-testid': testID,
    'aria-label': accessibilityLabel,
    value,
    onChange: onChangeText ? (event: any) => onChangeText(event.target.value) : undefined,
    onClick: onPress,
  }, children);
  return {
    Alert: { alert: vi.fn() },
    ScrollView: render('div'),
    TextInput: render('input'),
    ActivityIndicator: render('span'),
    FlatList: React.forwardRef((props: any, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: nativeList.scrollToIndex }));
      const { data, renderItem, testID } = props;
      return React.createElement('div', {
      'data-testid': testID,
      'data-row-count': String(data.length),
    }, ...data.slice(0, 5).map((item: string, index: number) => React.createElement(React.Fragment, { key: String(index) }, renderItem({ item, index }))));
    }),
    Modal: ({ children, visible }: any) => visible ? React.createElement('div', { 'data-testid': 'modal' }, children) : null,
    Pressable: render('button'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    View: render('div'),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

beforeEach(() => {
  downloadState.text = '';
  downloadState.tooLargeCount = 0;
  downloadState.failedCount = 0;
  vi.mocked(openBrowserAsync).mockClear();
  vi.mocked(withDownloadedRemoteMediaFile).mockReset().mockImplementation(async (
    _url,
    _mimeType,
    _maxBytes,
    read,
    _signal,
    onTooLarge,
  ) => {
    if (downloadState.tooLargeCount > 0) {
      downloadState.tooLargeCount -= 1;
      onTooLarge?.();
      return null;
    }
    if (downloadState.failedCount > 0) {
      downloadState.failedCount -= 1;
      return null;
    }
    return read({ text: async () => downloadState.text } as never);
  });
});

function makeAttachment(id: string, name: string, url: string): BotGroupAttachment {
  return { id, name, category: 'file', mimeType: 'application/octet-stream', size: 32, path: null, url };
}

async function renderPreview(kind: 'html' | 'markdown' | 'json', fileName: string, text: string, urls: string | readonly string[] = 'https://files.example.test/' + fileName) {
  downloadState.text = text;
  const resolvedUrls = typeof urls === 'string' ? [urls] : [...urls];
  let resolveIndex = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const resolve = vi.fn(async (id: string, _signal?: AbortSignal) => {
    const url = resolvedUrls[Math.min(resolveIndex, resolvedUrls.length - 1)]!;
    resolveIndex += 1;
    return makeAttachment(id, fileName, url);
  });
  const onClose = vi.fn();
  await act(async () => {
    root!.render(createElement(BotGroupTextAttachmentPreview, {
      attachmentId: 'attachment-id', fileName, kind, resolve, onClose,
    }));
    await new Promise(done => setTimeout(done, 0));
  });
  return { container: host, resolve, onClose, url: resolvedUrls[0]! };
}

describe('bot-group text attachment preview kinds', () => {
  it.each([
    ['report.html', 'html'],
    ['report.htm', 'html'],
    ['notes.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['summary.json', 'json'],
    ['page.xhtml', 'text'],
    ['source.ts', 'text'],
    ['archive.zip', null],
  ] as const)('classifies %s as %s', (name, expected) => {
    expect(botGroupTextAttachmentPreviewKind(name)).toBe(expected);
  });
});

describe('BotGroupTextAttachmentPreview', () => {
  it('renders HTML with JavaScript disabled after resolving a fresh HTTPS attachment', async () => {
    const { container, resolve } = await renderPreview('html', 'report.html', '<script>steal()</script><p>Report</p>');
    const reader = container.querySelector('[data-testid="groupChat.server.attachmentHtmlPreview"]');
    expect(resolve).toHaveBeenCalledWith('attachment-id', expect.any(AbortSignal));
    expect(reader?.getAttribute('data-javascript-enabled')).toBe('false');
    expect(reader?.textContent).toContain('Report');
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  it('keeps valid HTML form-feed whitespace readable', async () => {
    const { container } = await renderPreview('html', 'report.html', '<div\fclass="report">Form feed</div>');
    const reader = container.querySelector('[data-testid="groupChat.server.attachmentHtmlPreview"]');
    expect(reader).not.toBeNull();
    expect(reader?.textContent).toContain('Form feed');
  });

  it('sends Markdown through the existing reader without allowing remote image sources', async () => {
    const body = '![tracking pixel](https://tracker.example.test/pixel.png)';
    const { container } = await renderPreview('markdown', 'notes.md', body);
    const reader = container.querySelector('[data-testid="groupChat.server.attachmentMarkdownPreview"]');
    expect(reader?.getAttribute('data-image-source-count')).toBe('0');
    expect(reader?.textContent).toBe(body);
  });

  it('shows a size error, retries with fresh authorization, then displays numbered JSON lines', async () => {
    downloadState.tooLargeCount = 1;
    const { container, resolve } = await renderPreview('json', 'summary.json', '{"first":1}\n{"second":2}');
    expect(container.querySelector('[data-testid="groupChat.server.attachmentPreview.too-large"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="groupChat.server.attachmentPreviewOpenOutside"]')).not.toBeNull();
    const retry = container.querySelector('[data-testid="groupChat.server.attachmentPreviewRetry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await new Promise(done => setTimeout(done, 0));
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="groupChat.server.attachmentJsonPreview"]')?.textContent).toBe('1{"first":1}2{"second":2}');
  });

  it('caps excessive JSON line lists and tells the user when the preview is truncated', async () => {
    const body = Array.from({ length: 10_001 }, (_, index) => String(index)).join('\n');
    const { container } = await renderPreview('json', 'large.json', body);
    expect(container.querySelector('[data-testid="groupChat.server.attachmentJsonPreview"]')?.getAttribute('data-row-count')).toBe('10000');
    expect(container.textContent).toContain('groupChat.server.attachmentPreviewTruncated');
  });

  it('caps the rendered length of a single-line JSON file', async () => {
    const { container } = await renderPreview('json', 'compact.json', '{"value":"' + 'x'.repeat(256_000) + '"}');
    const list = container.querySelector('[data-testid="groupChat.server.attachmentJsonPreview"]');
    expect(list?.textContent?.length).toBeLessThanOrEqual(4_097);
    await act(async () => (container.querySelector('[aria-label="message.renderer.copyDetailContent"]') as HTMLButtonElement).click());
    expect(writeClipboardText).toHaveBeenLastCalledWith('{"value":"' + 'x'.repeat(256_000) + '"}');
    expect(container.textContent).toContain('groupChat.server.attachmentPreviewTruncated');
  });

  it('caps the total character budget across JSON lines', async () => {
    const body = Array.from({ length: 32 }, () => 'x'.repeat(4_096)).join('\n');
    const { container } = await renderPreview('json', 'many-lines.json', body);
    const list = container.querySelector('[data-testid="groupChat.server.attachmentJsonPreview"]');
    expect(list?.getAttribute('data-row-count')).toBe('25');
    expect(container.textContent).toContain('groupChat.server.attachmentPreviewTruncated');
  });

  // The 10,001-line device fixture found the match but RN FlatList clamped
  // jumps to its measured tail. Exercise the source reader's search-to-list
  // boundary; actual LegendList positioning is verified on iOS and Android.
  it('finds the distant visible line and asks the virtual list to position it', async () => {
    const body = Array.from({ length: 10_001 }, (_, index) => String(index)).join('\n');
    const { container } = await renderPreview('json', 'large.json', body);
    await act(async () => (container.querySelector('[aria-label="message.attachmentPreview.find"]') as HTMLButtonElement).click());
    const field = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '9999');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (container.querySelector('[aria-label="message.attachmentPreview.next"]') as HTMLButtonElement).click());
    expect(nativeList.scrollToIndex).toHaveBeenLastCalledWith({ index: 9999, viewPosition: 0.3, animated: false });
  });

  it('shows an explicit empty state for an empty text attachment', async () => {
    const { container } = await renderPreview('json', 'empty.json', '');
    expect(container.querySelector('[data-testid="groupChat.server.attachmentPreview.empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="groupChat.server.attachmentPreview.failed"]')).toBeNull();
  });

  it('renews the attachment URL before opening the browser fallback', async () => {
    downloadState.tooLargeCount = 1;
    const expiredUrl = 'https://files.example.test/expired.md';
    const renewedUrl = 'https://files.example.test/renewed.md';
    const { container, resolve, onClose } = await renderPreview('markdown', 'notes.md', 'body', [expiredUrl, renewedUrl]);
    const openOutside = container.querySelector('[data-testid="groupChat.server.attachmentPreviewOpenOutside"]') as HTMLButtonElement;
    await act(async () => {
      openOutside.click();
      await new Promise(done => setTimeout(done, 0));
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(openBrowserAsync).toHaveBeenCalledWith(renewedUrl);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects local file URLs and offers browser fallback only for a user-selected binary Markdown file', async () => {
    const local = await renderPreview('html', 'report.html', '<p>private</p>', 'file:///private/secret.html');
    expect(local.container.querySelector('[data-testid="groupChat.server.attachmentPreview.failed"]')).not.toBeNull();
    expect(withDownloadedRemoteMediaFile).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = undefined;
    local.container.remove();
    host = undefined;

    const binary = await renderPreview('markdown', 'notes.md', String.fromCharCode(0) + 'binary');
    expect(binary.container.querySelector('[data-testid="groupChat.server.attachmentPreview.binary"]')).not.toBeNull();
    const openOutside = binary.container.querySelector('[data-testid="groupChat.server.attachmentPreviewOpenOutside"]') as HTMLButtonElement;
    await act(async () => openOutside.click());
    expect(openBrowserAsync).toHaveBeenCalledWith(binary.url);
    expect(binary.onClose).toHaveBeenCalledOnce();
  });
});
