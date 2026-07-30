import { describe, expect, it } from 'vitest';

import {
  reportSubagentModelDiagnostics,
  resolveSubagentModelDefault,
  suggestModelIds,
} from '../subagent-model-default.js';
import type { DiscoveredSubagent } from '../subagent-definitions.js';
import type { SubagentModelDiagnostic } from '../subagent-model-default.js';

function agent(over: Partial<DiscoveredSubagent> & { name: string }): DiscoveredSubagent {
  return {
    filePath: `/home/u/.claude/agents/${over.name}.md`,
    scope: 'user',
    frontmatter: { name: over.name, description: `${over.name} desc` },
    ...over,
  };
}

describe('resolveSubagentModelDefault —— 设不设 env', () => {
  it('没配默认值 → 不设 env(与上线前一致)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a' })],
    });
    expect(r.envSubagentModel).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  it('空白字符串也算没配', () => {
    const r = resolveSubagentModelDefault({ configuredDefault: '   ', discovered: [] });
    expect(r.envSubagentModel).toBeUndefined();
  });

  it('没有任何 agent 声明 model → 设 env(内置 agent 也吃到默认值,行为零变化)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'claude-sonnet-5',
      discovered: [agent({ name: 'a' }), agent({ name: 'b' })],
    });
    expect(r.envSubagentModel).toBe('claude-sonnet-5');
  });

  it('完全没有 agent 文件时也设 env', () => {
    const r = resolveSubagentModelDefault({ configuredDefault: 'haiku', discovered: [] });
    expect(r.envSubagentModel).toBe('haiku');
  });

  it('有任一 agent 声明了 model → 不设 env(让声明生效,这是本次修复的核心)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'claude-sonnet-5',
      discovered: [
        agent({ name: 'x-search', declaredModel: 'xai/grok-4.5' }),
        agent({ name: 'plain' }),
      ],
    });
    expect(r.envSubagentModel).toBeUndefined();
  });

  it('declaredModel 为 undefined(发现层把 inherit 归一化过)时视作未声明', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'haiku',
      discovered: [agent({ name: 'a', declaredModel: undefined })],
    });
    expect(r.envSubagentModel).toBe('haiku');
  });
});

describe('声明模型的可用性校验', () => {
  const available = ['claude-opus-5', 'claude-sonnet-5', 'xai/grok-4.5', 'xai/grok-4.3'];

  it('声明了不存在的 model → unknown-model,并给出相近候选', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'typo', declaredModel: 'xai/grok-9.9' })],
      availableModelIds: available,
    });

    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      agent: 'typo',
      kind: 'unknown-model',
      declaredModel: 'xai/grok-9.9',
      availableModelCount: 4,
    });
    // 同命名空间的排前面。
    expect(r.diagnostics[0].suggestedModelIds.slice(0, 2)).toEqual(['xai/grok-4.5', 'xai/grok-4.3']);
  });

  it('校验独立于默认值 —— 没配默认值也照样报', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'nope' })],
      availableModelIds: available,
    });
    expect(r.diagnostics.map((d) => d.kind)).toEqual(['unknown-model']);
  });

  it('写错 model 的 agent 仍算「声明了」→ 依然不设 env(不能因为写错就回去覆盖别人)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'haiku',
      discovered: [agent({ name: 'a', declaredModel: 'nope' })],
      availableModelIds: available,
    });
    expect(r.envSubagentModel).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
  });

  // 裸别名能跑(所以不是 unknown-model),但二进制升级后别名会漂到下一代模型 —— 本仓踩过
  // 「选 Sonnet 5 实际命中 4.6」(见 index.ts toSdkModelString)。既不拦也不改用户文件,
  // 只出一条 alias-model 提示。
  it('平台裸别名不报 unknown,而是报 alias-model', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [
        agent({ name: 'a', declaredModel: 'sonnet' }),
        agent({ name: 'b', declaredModel: 'Opus' }),
        agent({ name: 'c', declaredModel: 'haiku' }),
        agent({ name: 'd', declaredModel: 'fable' }),
      ],
      availableModelIds: available,
    });
    expect(r.diagnostics.map((d) => d.kind)).toEqual([
      'alias-model',
      'alias-model',
      'alias-model',
      'alias-model',
    ]);
  });

  it('裸别名仍算「声明了」→ 照旧不设 env(尊重用户写下的东西)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: 'claude-opus-5',
      discovered: [agent({ name: 'a', declaredModel: 'sonnet' })],
      availableModelIds: available,
    });
    expect(r.envSubagentModel).toBeUndefined();
  });

  // 回归:maker-core 自己就把目录里的 claude-sonnet-5 转成 wire 串 claude-sonnet-5[1m]
  // (toSdkModelString)。把这种能正常工作的写法报成 unknown 是假警报。
  it('带 [1m] wire 后缀的合法 id 不误报', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [
        agent({ name: 'a', declaredModel: 'claude-sonnet-5[1m]' }),
        agent({ name: 'b', declaredModel: 'claude-opus-5[1m]' }),
      ],
      availableModelIds: available,
    });
    expect(r.diagnostics).toEqual([]);
  });

  // 回归:归一化必须发生在**分类之前**。`sonnet[1m]` 是 cc 认的历史 wire 形态
  // (legacyToSdkModelString 曾产出它),不归一化会被判成 unknown —— 而它其实是个会漂移的
  // 别名,是完全另一件事。
  it('带 [1m] 后缀的裸别名归到 alias-model,不误判成 unknown', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [
        agent({ name: 'a', declaredModel: 'sonnet[1m]' }),
        agent({ name: 'b', declaredModel: 'Opus[1m]' }),
      ],
      availableModelIds: available,
    });
    expect(r.diagnostics.map((d) => d.kind)).toEqual(['alias-model', 'alias-model']);
  });

  it('可用清单本身带 [1m] 时,不带后缀的声明也放行(两侧都归一)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'claude-sonnet-5' })],
      availableModelIds: ['claude-sonnet-5[1m]'],
    });
    expect(r.diagnostics).toEqual([]);
  });

  it('真实可用的 id 放行', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'xai/grok-4.5' })],
      availableModelIds: available,
    });
    expect(r.diagnostics).toEqual([]);
  });

  it('拿不到可用清单时不做校验(不误报)', () => {
    const r = resolveSubagentModelDefault({
      configuredDefault: undefined,
      discovered: [agent({ name: 'a', declaredModel: 'whatever' })],
    });
    expect(r.diagnostics).toEqual([]);
  });
});

describe('suggestModelIds', () => {
  // 实机踩过的坑:可用清单有 70+ 条,混着 embedding / image / audio 模型,全列既无用又误导。
  const many = [
    'claude-opus-5', 'claude-sonnet-5', 'chatgpt/gpt-5.5',
    'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-code-fast',
    'text-embedding-3-large', 'gpt-image-2', 'elevenlabs/eleven_v3',
    'voyage/voyage-4', 'gemini-3.5-flash', 'deepseek/deepseek-v4-pro',
  ];

  it('同命名空间前缀优先', () => {
    const s = suggestModelIds('xai/grok-9.9-nope', many);
    expect(s.slice(0, 3)).toEqual(['xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-code-fast']);
  });

  it('无命名空间时按词干匹配', () => {
    const s = suggestModelIds('grok-nine', many);
    expect(s[0]).toContain('grok');
  });

  it('最多 8 条,不倾倒整份清单', () => {
    expect(suggestModelIds('nonsense', many)).toHaveLength(8);
  });

  // 打分是同步的、且跑在扫描 deadline 之外,入参失控就是实打实的事件循环卡顿。
  // 上界必须只与「可用清单长度 × 词干上限」有关,与仓库塞进来的串多长无关。
  it('超长 declared 串不放大打分成本(词干与参与字符都有上限)', () => {
    const evil = Array.from({ length: 4000 }, (_, i) => `seg${i}`).join('-');
    const started = Date.now();
    const s = suggestModelIds(evil, many);
    expect(s.length).toBeLessThanOrEqual(8);
    // 不做精确计时断言(CI 机器抖动),只锁一个宽松上界:失控实现会是秒级。
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('同档内保持目录原序(结果稳定可预期)', () => {
    const s = suggestModelIds('xai/x', ['xai/b', 'xai/a']);
    expect(s).toEqual(['xai/b', 'xai/a']);
  });
});

describe('reportSubagentModelDiagnostics', () => {
  const one: SubagentModelDiagnostic[] = [
    {
      agent: 'a',
      filePath: '/p/a.md',
      kind: 'unknown-model',
      declaredModel: 'nope',
      suggestedModelIds: [],
      availableModelCount: 1,
    },
  ];

  it('正常回调收到诊断', () => {
    const seen: unknown[] = [];
    reportSubagentModelDiagnostics((d) => void seen.push(d), one);
    expect(seen).toEqual([one]);
  });

  it('没配回调 / 没有诊断都不调用', () => {
    expect(() => reportSubagentModelDiagnostics(undefined, one)).not.toThrow();
    const calls: number[] = [];
    reportSubagentModelDiagnostics(() => void calls.push(1), []);
    expect(calls).toEqual([]);
  });

  it('同步 throw 被接住', () => {
    expect(() =>
      reportSubagentModelDiagnostics(() => {
        throw new Error('host boom');
      }, one),
    ).not.toThrow();
  });

  // 回归:回调类型是 `=> void`,TS 在 void 位置接受任意返回值,host 完全可以传 async 函数。
  // 那时 reject 落在调用点的 try 之外 → unhandled rejection → Node 默认结束进程,
  // 与「上报失败不影响会话启动」的约定相反。必须对 thenable 显式挂 catch。
  it('async 回调的 reject 不逃逸成 unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      reportSubagentModelDiagnostics(
        (() => Promise.reject(new Error('async host boom'))) as unknown as (
          d: readonly SubagentModelDiagnostic[],
        ) => void,
        one,
      );
      // 让 microtask 队列跑完,unhandled rejection 若发生会在这之后被记上。
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('返回非 thenable 的普通值不报错', () => {
    expect(() =>
      reportSubagentModelDiagnostics((() => 42) as unknown as (
        d: readonly SubagentModelDiagnostic[],
      ) => void, one),
    ).not.toThrow();
  });
});
