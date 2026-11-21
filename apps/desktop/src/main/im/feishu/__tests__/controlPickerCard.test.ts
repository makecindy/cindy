import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../../i18n.desktop';
import type { ControlProject } from '../../shared/controlProjects';
import { createCardBuilders } from '../../shared/cardBuilders';
import { projectToken } from '../../shared/projectToken';
import { ui } from '../uiText';

// 控制文案跟随界面语言; 本文件断言的是中文原文。
beforeEach(() => setMainLocale('zh-CN'));
afterEach(() => setMainLocale('en'));

// cardBuilders 工厂只依赖 ui 文案包 + effort 查询函数 — 用 feishu 真实文案包
// 构造, effort 固定 'high'。
const cards = createCardBuilders(ui, () => 'high');

const PROJECTS: ControlProject[] = [
  { workingDir: '/Users/me/proj-a', displayName: 'proj-a', latestActivityMs: 2 },
  { workingDir: '/Users/me/proj-b', displayName: 'proj-b', latestActivityMs: 1 },
];

describe('buildControlPickerCard — 接管态换乘提示', () => {
  it('未接管时 body 不带"当前接管中"提示', () => {
    const spec = cards.buildControlPickerCard({ botAppId: 'bot1', projects: PROJECTS });
    expect(spec.body).not.toContain('当前接管中');
    // 项目按钮 + 退出按钮
    expect(spec.buttons).toHaveLength(PROJECTS.length + 1);
  });

  it('接管态下 body 顶部带当前会话名提示, 按钮结构不变', () => {
    const spec = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: PROJECTS,
      currentAttachedTitle: '修复登录 bug',
    });
    expect(spec.body).toContain('当前接管中');
    expect(spec.body).toContain('修复登录 bug');
    // 提示在 body 最前面 (picker hint 之前)
    expect(spec.body!.indexOf('当前接管中')).toBeLessThan(
      spec.body!.indexOf('点项目往下走'),
    );
    expect(spec.buttons).toHaveLength(PROJECTS.length + 1);
  });

  it('接管态 + 无可选工作区: 空态文案前同样带提示', () => {
    const spec = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: [],
      currentAttachedTitle: '修复登录 bug',
    });
    expect(spec.body).toContain('当前接管中');
    expect(spec.body).toContain('还没有可接管的项目');
    expect(spec.buttons).toHaveLength(1); // 只剩退出按钮
  });

  it('currentAttachedTitle 为 null/缺省时行为一致', () => {
    const a = cards.buildControlPickerCard({ botAppId: 'bot1', projects: PROJECTS });
    const b = cards.buildControlPickerCard({
      botAppId: 'bot1',
      projects: PROJECTS,
      currentAttachedTitle: null,
    });
    expect(b.body).toBe(a.body);
  });
});

// PR #10291 review: 飞书把按钮数据原样存到平台上, /project 卡片不能把本机绝对路径放进去
// (会带出用户名、仓库名)。生产入口 buildProjectPickerCard; 可观察结果是发给飞书的按钮数据。
describe('buildProjectPickerCard — 按钮数据不带本机路径', () => {
  it('项目按钮只带不透明标记与显示名', () => {
    const spec = cards.buildProjectPickerCard({
      botAppId: 'bot1',
      projects: PROJECTS,
      currentName: '对话',
    });
    const picks = spec.buttons.filter((button) => button.id === 'project:pick');
    expect(picks.map((button) => button.payload?.projectToken)).toEqual(
      PROJECTS.map((project) => projectToken(project.workingDir)),
    );
    for (const project of PROJECTS) {
      expect(JSON.stringify(spec.buttons)).not.toContain(project.workingDir);
    }
  });
});

describe('选项列表卡按列表排布(飞书一行一个满宽按钮, 文字不被压缩)', () => {
  it('/model、/project、/ctr、/session 及接管会话卡标记 list', () => {
    const sections = [
      {
        provider: { id: 'p1', name: '供应商一' },
        models: [
          { id: 'm1', displayName: '模型一号超长名称' },
          { id: 'm2', displayName: '模型二号超长名称' },
        ],
      },
    ] as unknown as Parameters<typeof cards.buildModelPickerCard>[0]['sections'];
    const specs = [
      cards.buildModelPickerCard({
        sessionId: 's1',
        agentKind: 'claude' as Parameters<typeof cards.buildModelPickerCard>[0]['agentKind'],
        sections,
        currentModelId: 'm1',
        currentProviderId: 'p1',
        currentEffort: null,
      }),
      cards.buildProjectPickerCard({ botAppId: 'bot1', projects: PROJECTS, currentName: 'proj-a' }),
      cards.buildControlPickerCard({ botAppId: 'bot1', projects: PROJECTS }),
      cards.buildControlSessionPickerCard({
        botAppId: 'bot1',
        workingDir: PROJECTS[0]!.workingDir,
        displayName: 'proj-a',
        sessions: [{ id: 'sess-1', title: '会话一' }] as unknown as Parameters<
          typeof cards.buildControlSessionPickerCard
        >[0]['sessions'],
      }),
    ];
    for (const spec of specs) expect(spec.buttonLayout).toBe('list');
  });

  it('空态卡只剩少量操作按钮, 保持默认横排', () => {
    expect(cards.buildControlPickerCard({ botAppId: 'bot1', projects: [] }).buttonLayout).toBeUndefined();
    expect(
      cards.buildProjectPickerCard({ botAppId: 'bot1', projects: [], currentName: 'x' }).buttonLayout,
    ).toBeUndefined();
  });
});

describe('buildModelPickerCard — 同名模型按供应商区分', () => {
  // 两家供应商都有一个叫 GPT-5.5 的模型: 只写模型名时,「当前」一行和选中后的回执都看不出是哪一家。
  const section = (id: string, name: string) => ({
    provider: { id, name },
    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', efforts: [], defaultEffort: null, contextWindow: 200_000 }],
  });
  const build = (currentProviderId: string | null) =>
    cards.buildModelPickerCard({
      sessionId: 'sess-1',
      agentKind: 'codex',
      sections: [section('openai', 'OpenAI'), section('relay', 'My Relay')] as unknown as Parameters<
        typeof cards.buildModelPickerCard
      >[0]['sections'],
      currentModelId: 'gpt-5.5',
      currentProviderId,
      currentEffort: 'high',
    });

  it('按钮、「当前」一行与选中后的回执都写出供应商', () => {
    const spec = build('relay');
    expect(spec.buttons!.map((button) => button.label)).toEqual([
      'OpenAI / GPT-5.5 · high',
      'My Relay / GPT-5.5 · high',
    ]);
    expect(spec.buttons!.map((button) => button.type)).toEqual(['default', 'primary']);
    expect(spec.body).toContain(ui.cards.model.currentLine('My Relay / GPT-5.5', 'high', ''));
    // 回执文案原样取 payload.modelLabel(见 cardActionHandler 的 model:pick)。
    expect(spec.buttons!.map((button) => button.payload?.modelLabel)).toEqual([
      'OpenAI / GPT-5.5',
      'My Relay / GPT-5.5',
    ]);
  });

  it('会话没有锁定来源、或锁定的来源不在清单里时,「当前」一行只写模型名', () => {
    for (const currentProviderId of [null, 'gone']) {
      const spec = build(currentProviderId);
      expect(spec.body).toContain(ui.cards.model.currentLine('GPT-5.5', 'high', ''));
      expect(spec.body).not.toContain(' / GPT-5.5');
      expect(spec.buttons!.every((button) => button.type === 'default')).toBe(true);
    }
  });
});
