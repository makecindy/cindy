// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionFileProvider } from '../components/chat/ChatSessionFileContext';
import { GeneratedFilesCard } from '../components/chat/GeneratedFilesCard';
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
});
