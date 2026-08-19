// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const seed = vi.fn(async () => ({ written: 0, skipped: 0 }));

beforeEach(() => {
  vi.setSystemTime(NOW);
  seed.mockClear();
  seed.mockImplementation(async () => ({ written: 0, skipped: 0 }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        botMemory: {
          list: async () => records,
          delete: async () => {},
          clear: async () => {},
          seed,
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

/*
  「有几条是 TA 加入时自带的」这句脚注只有在列表里**真的有**自带条目时才成立。
  写死它会让写入失败(或用户把那几条删光)之后的空列表配上一句假话。
*/
describe('BotGrowthLists — 自带笔记的脚注与补写', () => {
  const seedEntries = [
    {
      slug: 'one-thing-per-reminder',
      type: 'reference' as const,
      title: '一条提醒只说一件事',
      description: '提醒写短',
      body: '提醒要短。',
    },
  ];

  it('says the neutral line while no starting note is in the list', async () => {
    records = [];
    render(<BotGrowthLists botId="bot-1" highlight={null} seedEntries={seedEntries} />);

    expect(await screen.findByText('bots.memoryList.footnote')).toBeTruthy();
    expect(screen.queryByText('bots.memoryList.footnoteWithSeed')).toBeNull();
  });

  it('switches to the "came with them" line once a starting note is really there', async () => {
    records = [
      record({
        filename: 'reference_one-thing-per-reminder.md',
        slug: 'one-thing-per-reminder',
        title: '一条提醒只说一件事',
        description: '提醒写短',
        updatedAt: new Date(NOW).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} seedEntries={seedEntries} />);

    expect(await screen.findByText('bots.memoryList.footnoteWithSeed')).toBeTruthy();
    expect(screen.queryByText('bots.memoryList.footnote')).toBeNull();
    // 自带条目在场时不再提供补写入口。
    expect(screen.queryByText('bots.memoryList.seedBack')).toBeNull();
  });

  it('recognises a generated teammate\'s start-N notes as starting notes too', async () => {
    records = [
      record({
        filename: 'reference_start-1.md',
        slug: 'start-1',
        title: '先给三版',
        description: '不一上来就定稿',
        updatedAt: new Date(NOW).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    expect(await screen.findByText('bots.memoryList.footnoteWithSeed')).toBeTruthy();
  });

  it('does not mistake a memory the teammate grew for a starting note', async () => {
    records = [
      record({
        filename: 'reference_likes-short-replies.md',
        slug: 'likes-short-replies',
        title: '喜欢短回复',
        description: '从对话里记下的',
        updatedAt: new Date(NOW).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    expect(await screen.findByText('bots.memoryList.footnote')).toBeTruthy();
  });

  /*
    加入时那次写入是 best-effort(失败不回滚伙伴)。失败之后总得有一条自己补回来的
    路,否则那几条笔记就永远没了 —— seed IPC 按 slug 幂等,重复点是安全的。
  */
  it('offers a way to write the starting notes back after a failed seed', async () => {
    records = [];
    render(<BotGrowthLists botId="bot-1" highlight={null} seedEntries={seedEntries} />);

    const button = await screen.findByText('bots.memoryList.seedBack');
    records = [
      record({
        filename: 'reference_one-thing-per-reminder.md',
        slug: 'one-thing-per-reminder',
        title: '一条提醒只说一件事',
        description: '提醒写短',
        updatedAt: new Date(NOW).toISOString(),
      }),
    ];
    fireEvent.click(button);

    await waitFor(() => expect(seed).toHaveBeenCalledWith('bot-1', seedEntries));
    // 补写完立即重新拉列表,那几条当场出现,脚注也跟着换。
    expect(await screen.findByText('一条提醒只说一件事')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('bots.memoryList.seedBack')).toBeNull());
  });

  it('never offers the retry when there is nothing recoverable to write', async () => {
    records = [];
    // 没有模板可反查(改过名 / AI 生成的伙伴)—— 不能凭空造几条顶上。
    render(<BotGrowthLists botId="bot-1" highlight={null} seedEntries={[]} />);

    expect(await screen.findByText('bots.memoryList.footnote')).toBeTruthy();
    expect(screen.queryByText('bots.memoryList.seedBack')).toBeNull();
  });

  it('surfaces a failed retry instead of silently doing nothing', async () => {
    records = [];
    seed.mockRejectedValue(new Error('memory offline'));
    render(<BotGrowthLists botId="bot-1" highlight={null} seedEntries={seedEntries} />);

    fireEvent.click(await screen.findByText('bots.memoryList.seedBack'));

    expect(await screen.findByText('memory offline')).toBeTruthy();
    expect(screen.getByText('bots.memoryList.seedBack')).toBeTruthy();
  });
});
