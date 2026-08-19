// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => true }),
}));

import { BotGrowthLists } from '../BotGrowthLists';

const NOW = 1_786_000_000_000;

function record(overrides: {
  filename: string;
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
  type?: string;
}) {
  return {
    filename: overrides.filename,
    slug: overrides.slug,
    sizeBytes: 128,
    body: '',
    frontmatter: {
      type: overrides.type ?? 'reference',
      title: overrides.title,
      description: overrides.description,
      updatedAt: overrides.updatedAt,
    },
  };
}

let records: unknown[] = [];

beforeEach(() => {
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        botMemory: {
          list: async () => records,
          delete: async () => {},
          clear: async () => {},
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BotGrowthLists — 「TA 记得的」/「TA 学会的」', () => {
  it('描述为空时副行不留下一个没有左操作数的分隔点', async () => {
    // `learned-` 前缀走「TA 学会的」,那一列会带来源时间。描述可空(老分片、
    // 手写分片都可能没有 hook 那一行),此时副行必须只有时间,不能是「· 刚刚」。
    records = [
      record({
        filename: 'reference_learned-no-desc.md',
        slug: 'learned-no-desc',
        title: '写公告先按作者邮箱归一化再分组',
        description: '',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    const list = await screen.findByTestId('bot-learned-list');
    await waitFor(() => {
      expect(list.textContent).toMatch(/bots\.artifacts\.time\./);
    });
    // 只有时间一个片段时，整行不该出现分隔点。
    expect(list.textContent).not.toContain('·');
  });

  it('描述与时间都在时用 · 连起来', async () => {
    records = [
      record({
        filename: 'reference_learned-with-desc.md',
        slug: 'learned-with-desc',
        title: '过 PR 的顺序',
        description: '先看 DCO',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    const list = await screen.findByTestId('bot-learned-list');
    await waitFor(() => {
      expect(list.textContent).toMatch(/先看 DCO · bots\.artifacts\.time\./);
    });
  });

  it('「TA 记得的」不带时间,只有描述时副行就是描述本身', async () => {
    records = [
      record({
        type: 'feedback',
        filename: 'feedback_tone.md',
        slug: 'tone',
        title: '结论在前',
        description: '理由放后面',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    const list = await screen.findByTestId('bot-memory-list');
    await waitFor(() => {
      expect(list.textContent).toContain('理由放后面');
    });
    expect(list.textContent).not.toContain('bots.artifacts.time.');
  });
});
