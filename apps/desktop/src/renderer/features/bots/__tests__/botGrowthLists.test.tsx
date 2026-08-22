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
let skills: unknown[] = [];
const seed = vi.fn(async () => ({ written: 0, skipped: 0 }));
const readSkill = vi.fn(async (_botId: string, slug: string) => ({
  slug,
  name: slug,
  description: '',
  updatedAt: new Date(NOW).toISOString(),
  body: `steps for ${slug}`,
}));
const deleteSkill = vi.fn(async () => ({ ok: true as const, deleted: true }));

beforeEach(() => {
  vi.setSystemTime(NOW);
  seed.mockClear();
  readSkill.mockClear();
  deleteSkill.mockClear();
  seed.mockImplementation(async () => ({ written: 0, skipped: 0 }));
  deleteSkill.mockImplementation(async () => ({ ok: true as const, deleted: true }));
  skills = [];
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
        botSkill: {
          list: async () => skills,
          read: readSkill,
          delete: deleteSkill,
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
  批次 ζ:「TA 学会的」列的是**真技能**(伙伴自己调 save_bot_skill 存下的
  SKILL.md,下一次会话会被 harness 真正挂载),不再只是 `learned-` 记忆分片的切片。
  老的 `learned-` 分片一条不丢,但要以「笔记」的身份、和技能分开呈现。
*/
describe('BotGrowthLists — 「TA 学会的」列真技能', () => {
  const skill = (name: string, description = '') => ({
    slug: name,
    name,
    description,
    updatedAt: new Date(NOW - 60_000).toISOString(),
  });

  it('lists the real skills the teammate distilled, with their hook and time', async () => {
    records = [];
    skills = [skill('weekly-report', '写周报的顺序')];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    const list = await screen.findByTestId('bot-skill-list');
    expect(list.textContent).toContain('weekly-report');
    await waitFor(() => {
      expect(list.textContent).toMatch(/写周报的顺序 · bots\.artifacts\.time\./);
    });
  });

  it('opens the steps in place instead of dragging the user out of settings', async () => {
    records = [];
    skills = [skill('weekly-report')];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    fireEvent.click(await screen.findByText('weekly-report'));

    expect(await screen.findByText('steps for weekly-report')).toBeTruthy();
    expect(readSkill).toHaveBeenCalledWith('bot-1', 'weekly-report');
  });

  it('deletes a skill behind a confirm and drops it from the list', async () => {
    records = [];
    skills = [skill('weekly-report')];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    const button = await screen.findByLabelText(
      'bots.learned.deleteAria:{"title":"weekly-report"}',
    );
    skills = [];
    fireEvent.click(button);

    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith('bot-1', 'weekly-report'));
    await waitFor(() => expect(screen.queryByTestId('bot-skill-list')).toBeNull());
  });

  it('keeps the old learned- memory notes, told apart from real skills', async () => {
    skills = [skill('weekly-report')];
    records = [
      record({
        filename: 'reference_learned-shrink-email.md',
        slug: 'learned-shrink-email',
        title: '把长邮件缩成三行',
        description: '',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
    ];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    // 两组各自成组:技能能挂载,笔记不能 —— 混在一起用户会以为每条都是本事。
    expect((await screen.findByTestId('bot-skill-list')).textContent).toContain('weekly-report');
    const notes = await screen.findByTestId('bot-learned-notes');
    expect(notes.textContent).toContain('bots.learned.notesTitle');
    expect(notes.textContent).toContain('把长邮件缩成三行');
    expect(notes.textContent).not.toContain('weekly-report');
    expect(screen.queryByText('bots.learned.empty')).toBeNull();
  });

  it('only says "nothing learned yet" when both groups are really empty', async () => {
    records = [];
    skills = [];
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    expect(await screen.findByText('bots.learned.empty')).toBeTruthy();
  });

  it('still renders on an older preload that has no skill bridge', async () => {
    // 新 renderer 撞上旧 preload 时按「还没学会任何东西」处理,不整块报错。
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { maker: { botMemory: { list: async () => [], delete: async () => {}, clear: async () => {}, seed } } },
    });
    render(<BotGrowthLists botId="bot-1" highlight={null} />);

    expect(await screen.findByText('bots.learned.empty')).toBeTruthy();
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
