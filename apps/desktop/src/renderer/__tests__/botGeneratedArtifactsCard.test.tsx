// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionFileProvider } from '../components/chat/ChatSessionFileContext';
import { GeneratedFilesCard } from '../components/chat/GeneratedFilesCard';
import { groupWorkRuns, type RenderItem } from '../components/chat/messageWorkGroups';
import { simplifyBotRenderItems } from '../features/bots/botConversationPresentation';
import { useBotGeneratedFileDeliveries } from '../features/bots/useBotGeneratedFileDeliveries';
import type { ChatSessionFileContextValue } from '../components/chat/ChatSessionFileContext';
import { LOCAL_FILE_ORIGIN } from '../lib/sessionFileOrigin';
import type { GeneratedFileRef } from '../lib/generatedFiles';

const mocks = vi.hoisted(() => ({
  openHtmlFileByPreference: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        if (key === 'chat.generatedFiles.botTitle') return '本次成果';
        if (key === 'chat.generatedFiles.relatedFiles') return `相关文件 ${vars?.count}`;
        if (key === 'chat.generatedFiles.openWebPreview') return '打开网页预览';
        return key;
      },
    }),
  };
});

vi.mock('../components/chat/useOpenWithMenu', () => ({
  isHtmlFilePath: (path: string) => /\.(html?|xhtml)$/i.test(path),
  openHtmlFileByPreference: mocks.openHtmlFileByPreference,
}));

vi.mock('../components/chat/useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({
    onContextMenu: vi.fn(),
    openAt: vi.fn(),
    menu: null,
  }),
}));

vi.mock('../components/chat/ImageLightbox', () => ({
  ImageLightbox: () => <div data-testid="image-lightbox" />,
}));
vi.mock('../components/chat/TextLightbox', () => ({
  TextLightbox: () => <div data-testid="text-lightbox" />,
}));
vi.mock('../components/chat/ModelLightbox', () => ({
  ModelLightbox: () => <div data-testid="model-lightbox" />,
}));

type FileStat = Awaited<ReturnType<typeof window.electronAPI.fsBrowse.statPath>>;
const START = 1_000;
const END = 5_000;

function generated(path: string): GeneratedFileRef {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    source: 'tool',
  };
}

function renderCard(files: readonly GeneratedFileRef[]) {
  return render(
    <ChatSessionFileProvider
      value={{ sessionId: 'bot-session', workingDir: '/bot/workspace', origin: LOCAL_FILE_ORIGIN }}
    >
      <GeneratedFilesCard
        files={files}
        turnStartMs={START}
        turnEndMs={END}
        turnSealed
        botArtifacts
      />
    </ChatSessionFileProvider>,
  );
}

const fileScope: ChatSessionFileContextValue = {
  sessionId: 'bot-session', workingDir: '/bot/workspace', origin: LOCAL_FILE_ORIGIN,
};
function conversationFiles(path = '/bot/workspace/result.pdf'): RenderItem[] {
  return [
    { type: 'message', key: 'progress', message: {
      clientId: 'progress', role: 'assistant', content: 'Generating the report',
    } },
    { type: 'tool_segment', key: 'write', toolCalls: [{
      clientId: 'write', toolUseId: 'write', role: 'tool_use', toolName: 'Write', content: '',
    }], resultMap: new Map(), settledIds: new Set(['write']), resultTsMap: new Map() },
    { type: 'generated_files', key: 'files', files: [generated(path)],
      turnStartMs: START, turnEndMs: END, turnSealed: true },
  ];
}

// The same projection/visibility wiring as MessageStream, using the real card's
// asynchronous checks. Only unrelated lightbox/open-file services are mocked.
function Conversation({ items, streaming = false, scope = fileScope, mounted = true }: {
  items: RenderItem[]; streaming?: boolean; scope?: ChatSessionFileContextValue; mounted?: boolean;
}) {
  const { visibleGeneratedFileKeys, onGeneratedFilesVisibilityChange } = useBotGeneratedFileDeliveries(items, scope);
  const projected = simplifyBotRenderItems(groupWorkRuns(items, streaming), streaming, visibleGeneratedFileKeys);
  return <ChatSessionFileProvider value={scope}>
    {projected.map((item) => {
      if (item.type === 'generated_files' && mounted) return <GeneratedFilesCard key={item.key}
        files={item.files} turnStartMs={item.turnStartMs} turnEndMs={item.turnEndMs}
        turnSealed={item.turnSealed} botArtifacts onVisibilityChange={onGeneratedFilesVisibilityChange} />;
      if (item.type === 'message') return <div key={item.key} data-testid={item.message.role === 'assistant' ? 'main-prose' : 'error'}>{item.message.content}</div>;
      if (item.type === 'work_group') return <div key={item.key} data-testid="public-process">
        {item.children.flatMap((child) => child.type === 'message' ? [child.message.content] : [])}
      </div>;
      return null;
    })}
  </ChatSessionFileProvider>;
}

describe('伙伴成果卡', () => {
  beforeEach(() => {
    mocks.openHtmlFileByPreference.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        fsBrowse: {
          statPath: vi.fn(async () => ({
            kind: 'file',
            birthtimeMs: START + 100,
            mtimeMs: START + 100,
          })),
        },
      },
    });
  });

  afterEach(cleanup);

  it('展示 SVG 缩略图与网页成品，默认收起 index 预览页和辅助文件', async () => {
    renderCard([
      generated('/bot/workspace/logo-A.svg'),
      generated('/bot/workspace/index.html'),
      generated('/bot/workspace/猫岛邮局-logo-方案.html'),
      generated('/bot/workspace/_preview/C_full.png'),
      generated('/bot/workspace/styles.css'),
    ]);

    await screen.findByTestId('bot-generated-artifacts');
    expect(screen.getByRole('img', { name: 'logo-A.svg' })).toBeTruthy();
    expect(screen.getByText('logo-A.svg')).toBeTruthy();
    expect(screen.queryByText('index.html')).toBeNull();
    expect(screen.queryByText('C_full.png')).toBeNull();
    expect(screen.queryByText('styles.css')).toBeNull();

    fireEvent.click(screen.getByText('猫岛邮局-logo-方案.html').closest('button')!);
    await waitFor(() => {
      expect(mocks.openHtmlFileByPreference).toHaveBeenCalledWith(
        'bot-session',
        '/bot/workspace/猫岛邮局-logo-方案.html',
        expect.any(Function),
        expect.objectContaining({ origin: { kind: 'local' } }),
      );
    });
    expect(screen.queryByTestId('text-lightbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '相关文件 3' }));
    expect(screen.getByText('logo-A.svg')).toBeTruthy();
    expect(screen.getByText('index.html')).toBeTruthy();
    expect(screen.getByText('C_full.png')).toBeTruthy();
    expect(screen.getByText('styles.css')).toBeTruthy();
  });

  it('缩略图加载失败时只降级当前成果，不让整组消失', async () => {
    renderCard([generated('/bot/workspace/logo-A.png')]);

    const image = await screen.findByRole('img', { name: 'logo-A.png' });
    fireEvent.error(image);

    await waitFor(() => expect(screen.queryByRole('img', { name: 'logo-A.png' })).toBeNull());
    expect(screen.getByText('logo-A.png')).toBeTruthy();
    expect(screen.getByTestId('bot-generated-artifacts')).toBeTruthy();
  });

  it.each(['stop', 'error', 'history'])('omits the preamble and process entry once a real generated file is visible: %s', async (ending) => {
    let finish!: (value: FileStat) => void;
    const stat = vi.fn(() => new Promise<FileStat>((resolve) => { finish = resolve; }));
    window.electronAPI.fsBrowse.statPath = stat;
    const items = conversationFiles();
    if (ending === 'error') items.push({ type: 'message', key: 'error', message: {
      clientId: 'error', role: 'error', content: 'Generation interrupted',
    } });
    const view = render(<Conversation items={items} streaming={ending !== 'history'} />);
    if (ending !== 'history') expect(screen.queryByTestId('main-prose')).toBeNull();
    view.rerender(<Conversation items={items} />);
    // Until stat confirms a visible delivery, a no-final turn keeps useful text.
    expect(screen.getByTestId('main-prose').textContent).toBe('Generating the report');
    await act(async () => finish({ kind: 'file', resolvedPath: '/bot/workspace/result.pdf', birthtimeMs: START + 100, mtimeMs: START + 100 }));
    expect(screen.getByText('result.pdf')).toBeTruthy();
    expect(screen.queryByTestId('main-prose')).toBeNull();
    expect(screen.queryByTestId('public-process')).toBeNull();
    expect(screen.queryByText('Generating the report')).toBeNull();
    if (ending === 'error') expect(screen.getByTestId('error').textContent).toBe('Generation interrupted');
    expect(stat).toHaveBeenCalledTimes(1);
    // Virtualized cards leaving the viewport must not revive the preamble.
    view.rerender(<Conversation items={items} mounted={false} />);
    expect(screen.queryByTestId('main-prose')).toBeNull();
    view.rerender(<Conversation items={items} />);
    expect(screen.queryByTestId('main-prose')).toBeNull();
    expect(stat).toHaveBeenCalledTimes(2);
    await act(async () => finish({ kind: 'missing', resolvedPath: '/bot/workspace/result.pdf' }));
    expect(screen.getByTestId('main-prose')).toBeTruthy();
  });

  it.each(['missing', 'old', 'failure'])('retains no-final fallback when file checks reject delivery: %s', async (verdict) => {
    const stat = vi.fn(async (): Promise<FileStat> => {
      if (verdict === 'failure') throw new Error('stat unavailable');
      return verdict === 'old' ? { kind: 'file', resolvedPath: '/bot/workspace/result.pdf', birthtimeMs: 1, mtimeMs: 1 } : { kind: 'missing', resolvedPath: '/bot/workspace/result.pdf' };
    });
    window.electronAPI.fsBrowse.statPath = stat;
    await act(async () => { render(<Conversation items={conversationFiles()} />); });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('bot-generated-artifacts')).toBeNull();
    expect(screen.getByTestId('main-prose').textContent).toBe('Generating the report');
  });

  it('invalidates delivery for changed candidates and ignores an obsolete async completion', async () => {
    let finishOld!: (value: FileStat) => void;
    const stat = vi.fn().mockImplementationOnce(() => new Promise<FileStat>((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ kind: 'missing', resolvedPath: '/bot/workspace/missing.pdf' });
    window.electronAPI.fsBrowse.statPath = stat;
    const view = render(<Conversation items={conversationFiles()} />);
    view.rerender(<Conversation items={conversationFiles('/bot/workspace/missing.pdf')} />);
    await act(async () => finishOld({ kind: 'file', resolvedPath: '/bot/workspace/result.pdf', birthtimeMs: START + 100, mtimeMs: START + 100 }));
    expect(screen.queryByTestId('bot-generated-artifacts')).toBeNull();
    expect(screen.getByTestId('main-prose')).toBeTruthy();
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('does not use a previous candidate confirmation for a missing replacement', async () => {
    const view = render(<Conversation items={conversationFiles()} />);
    await screen.findByTestId('bot-generated-artifacts');
    expect(screen.queryByTestId('main-prose')).toBeNull();
    window.electronAPI.fsBrowse.statPath = vi.fn(async (): Promise<FileStat> => ({ kind: 'missing', resolvedPath: '/bot/workspace/missing.pdf' }));
    await act(async () => { view.rerender(<Conversation items={conversationFiles('/bot/workspace/missing.pdf')} />); });
    expect(screen.queryByTestId('bot-generated-artifacts')).toBeNull();
    expect(screen.getByTestId('main-prose')).toBeTruthy();
  });

  it('does not carry a visible delivery into a new file context or time window', async () => {
    const items = conversationFiles();
    const view = render(<Conversation items={items} />);
    await screen.findByTestId('bot-generated-artifacts');
    expect(screen.queryByTestId('main-prose')).toBeNull();
    const stat = vi.fn(async (): Promise<FileStat> => ({ kind: 'missing', resolvedPath: '/bot/workspace/missing.pdf' }));
    window.electronAPI.fsBrowse.statPath = stat;
    const scope = { ...fileScope, sessionId: 'different-session', workingDir: '/different' };
    await act(async () => { view.rerender(<Conversation items={items} scope={scope} />); });
    expect(screen.queryByTestId('bot-generated-artifacts')).toBeNull();
    expect(screen.getByTestId('main-prose')).toBeTruthy();
    expect(stat).toHaveBeenCalledTimes(1);
    const updated = items.map((item) => item.type === 'generated_files' ? { ...item, turnEndMs: END + 100 } : item);
    await act(async () => { view.rerender(<Conversation items={updated} scope={scope} />); });
    expect(screen.getByTestId('main-prose')).toBeTruthy();
    expect(stat).toHaveBeenCalledTimes(2);
  });

});
