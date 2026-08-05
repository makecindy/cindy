/**
 * 自定义市场指南对话框：结构树里的解释性标签必须跟随界面语言，且展示与复制内容一致。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// 用真实的 en 资源渲染:硬编码中文标签会直接暴露在断言里。
const enGuide: Record<string, string> = {
  structureLabelManifest: 'manifest',
  structureLabelGhostCard: 'Plugin card',
  structureLabelEntry: 'Plugin entry',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const suffix = key.replace('settings.ghosts.market.sources.guide.', '');
      return enGuide[suffix] ?? suffix;
    },
  }),
}));

const copied: string[] = [];
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MarketplaceGuideDialog } from '../MarketplaceGuideDialog';

describe('MarketplaceGuideDialog', () => {
  it('localizes the structure annotations instead of hardcoding Chinese', () => {
    render(<MarketplaceGuideDialog open onOpenChange={() => {}} />);
    const tree = screen.getByText(/my-marketplace\//);
    const text = tree.textContent ?? '';

    // 路径本身不翻译。
    expect(text).toContain('.agents/plugins/marketplace.json');
    expect(text).toContain('ghost.json');
    // 箭头后的标签必须来自 locale 资源。
    expect(text).toContain('manifest');
    expect(text).toContain('Plugin card');
    expect(text).toContain('Plugin entry');
    // 英文界面下不得残留中文标签。
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it('copies the same localized tree that is displayed', async () => {
    const writeText = vi.fn(async (value: string) => {
      copied.push(value);
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(<MarketplaceGuideDialog open onOpenChange={() => {}} />);
    const displayed = screen.getByText(/my-marketplace\//).textContent ?? '';
    screen.getByRole('button', { name: 'copy' }).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    const payload = copied.at(-1) ?? '';
    // 复制出来的内容与界面上看到的是同一份(不能一处本地化、一处仍是中文)。
    expect(payload).toContain(displayed.trim());
    expect(payload).not.toMatch(/[一-鿿]/);
    vi.unstubAllGlobals();
  });
});
