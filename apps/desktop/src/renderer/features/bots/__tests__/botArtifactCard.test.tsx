// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { BotArtifactCard } from '../BotArtifactCard';
import { makeBotArtifact } from '../../../../shared/botArtifact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));

/** 让卡片能读到「真实」文件头:peek-file-header 是既有只读 IPC,这里给它一份内容。 */
function stubFileHead(text: string, opts?: { truncated?: boolean }) {
  const bytes = new TextEncoder().encode(text);
  const base64 = Buffer.from(bytes).toString('base64');
  const peekFileHeader = vi.fn(async () => ({
    success: true,
    data: base64,
    actualBytes: bytes.length,
    totalSize: opts?.truncated ? bytes.length + 4096 : bytes.length,
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { peekFileHeader };
  return peekFileHeader;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function artifact(target: string, isRef = false) {
  return makeBotArtifact({
    source: isRef ? 'delegation' : 'generated',
    target,
    isRef,
    createdAt: Date.now() - 30_000,
  });
}

describe('BotArtifactCard', () => {
  it.each([
    ['/w/plan.md', 'doc'],
    ['/w/data.csv', 'sheet'],
    ['/w/hero.png', 'image'],
    ['/w/q3.pptx', 'deck'],
    ['/w/bundle.zip', 'other'],
  ])('renders %s as the %s card', (target, category) => {
    render(<BotArtifactCard item={artifact(target)} onOpen={() => {}} />);
    const card = screen.getByTestId('bot-artifact-card');
    expect(card.getAttribute('data-artifact-category')).toBe(category);
  });

  it('shows title and a 类型 · 时间 meta line, and omits size when unknown', () => {
    render(<BotArtifactCard item={artifact('/w/plan.md')} onOpen={() => {}} />);
    expect(screen.getByText('plan.md')).toBeTruthy();
    // 「类型 · 时间」两段;体积未知不占位。
    expect(
      screen.getByText('bots.artifacts.category.doc · bots.artifacts.time.justNow'),
    ).toBeTruthy();
  });

  it('renders a real thumbnail for image artifacts instead of an icon block', () => {
    render(<BotArtifactCard item={artifact('cindy-media://blobs/h.png', true)} onOpen={() => {}} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('cindy-media://blobs/h.png');
  });

  it('renders a real 4-row mini table for csv spreadsheets', async () => {
    const peek = stubFileHead(
      ['日期,事项,状态,备注', '周一,"需求评审, 二轮",已完成,x', '周三,灰度上线,已完成,y', '周五,数据复盘,待确认,z', '周日,不该出现,待确认,w'].join('\n'),
    );
    render(<BotArtifactCard item={artifact('/w/plan.csv')} onOpen={() => {}} />);
    const preview = await screen.findByTestId('bot-artifact-sheet-preview');
    expect(peek).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/w/plan.csv' }));
    // 4 行 × 3 列;引号内的逗号不被切开;第 5 行与第 4 列都不进预览。
    expect(preview.children).toHaveLength(4);
    expect(preview.textContent).toContain('需求评审, 二轮');
    expect(preview.textContent).not.toContain('不该出现');
    expect(preview.textContent).not.toContain('备注');
    expect([...preview.children[0]!.children]).toHaveLength(3);
  });

  it('parses tsv with tabs', async () => {
    stubFileHead('a\tb\tc\n1\t2\t3\n');
    render(<BotArtifactCard item={artifact('/w/data.tsv')} onOpen={() => {}} />);
    const preview = await screen.findByTestId('bot-artifact-sheet-preview');
    expect(preview.children).toHaveLength(2);
    expect(preview.textContent).toContain('a');
  });

  it('falls back to the icon for xlsx — no parser in the repo, no invented table', async () => {
    stubFileHead('irrelevant');
    render(<BotArtifactCard item={artifact('/w/report.xlsx')} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText('report.xlsx')).toBeTruthy());
    expect(screen.queryByTestId('bot-artifact-sheet-preview')).toBeNull();
  });

  it('never reads the local disk for a remote session — icon fallback instead', async () => {
    const peek = stubFileHead('a,b,c\n1,2,3\n');
    render(
      <ChatSessionFileProvider
        value={{ sessionId: 's1', workingDir: '/w', origin: { kind: 'ssh', remoteHostId: 'h1' } }}
      >
        <BotArtifactCard item={artifact('/w/data.csv')} onOpen={() => {}} />
      </ChatSessionFileProvider>,
    );
    await waitFor(() => expect(screen.getByText('data.csv')).toBeTruthy());
    expect(peek).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bot-artifact-sheet-preview')).toBeNull();
  });

  it('shows no preview when the file head cannot be read', async () => {
    render(<BotArtifactCard item={artifact('/w/data.csv')} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText('data.csv')).toBeTruthy());
    expect(screen.queryByTestId('bot-artifact-sheet-preview')).toBeNull();
  });

  it('opens through the action and stays free of a repo jump when none is wired', () => {
    const onOpen = vi.fn();
    const item = artifact('/w/plan.md');
    render(<BotArtifactCard item={item} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('bots.artifacts.open'));
    expect(onOpen).toHaveBeenCalledWith(item);
    expect(screen.queryByText('bots.artifacts.reveal')).toBeNull();
  });

  it('offers 在仓库中查看 only when a reveal handler is supplied', () => {
    const onReveal = vi.fn();
    const item = artifact('/w/plan.md');
    render(<BotArtifactCard item={item} onOpen={() => {}} onReveal={onReveal} />);
    fireEvent.click(screen.getByText('bots.artifacts.reveal'));
    expect(onReveal).toHaveBeenCalledWith(item);
  });

  it('falls back to the icon block when the thumbnail fails to load', () => {
    render(<BotArtifactCard item={artifact('/w/hero.png')} onOpen={() => {}} />);
    const img = screen.getByRole('img');
    fireEvent.error(img);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('hero.png')).toBeTruthy();
  });
});
