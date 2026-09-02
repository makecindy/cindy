/**
 * 压缩之后伙伴还是不是它自己。
 *
 * ## 为什么这组测试是源码断言
 *
 * 这条链跨三个 harness translator + maker-host + maker-ipc,真跑一遍要起三个
 * agent 进程。而它要防的事故是**有人不小心把某一环拆了**:那种改动在类型上
 * 完全合法,单测也不会红,只有用户会发现「压缩之后伙伴忘了自己是谁」。
 * 所以这里钉的是接线本身存在,不是它的运行时行为。
 *
 * ## 为什么 Cindy 不需要 Hermes 那条「压缩续接链」
 *
 * Hermes 压缩时**必须换一条会话**:它的记录是 append-only 的 jsonl 文件,压缩
 * 只能写新文件。于是它需要 `get_compression_tip` 沿父子链走到链尾,还要排除
 * 分支/委派/工具子会话、偏好还活着的那一节、加 100 层防御上限 —— 它自己的注释
 * 里记着那条链出过的事故:桌面端跟错到一个僵尸兄弟会话,用户最新的消息看起来
 * 「丢了」。
 *
 * Cindy 的会话在 SQLite 里,压缩**就地发生、会话 id 不变**。于是:
 *
 *   - 侧栏不跳、作品集不断、右栏 tab 不重挂、device-link 不用重新解析归属;
 *   - 没有链,也就没有跟错节点这回事。
 *
 * 代价是压缩后 agent 进程要重建(旧 runtime 关掉、按当前档案重新 bootstrap),
 * 这正是 `botCompactRuntimeRefresh` 那个协调器在做的事 —— 它顺带解决了 Hermes
 * 那条链**没有**解决的问题:压缩后把灵魂、技能索引、记忆快照重新注入。
 *
 * 结论:这里**有意不实现**续接链。抄过来是退步。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../../..');

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

describe('三个 harness 都会报压缩边界', () => {
  it('Claude Code:原生 compact_boundary', () => {
    expect(read('packages/maker-core/src/agents/claude-code/translator.ts')).toContain(
      "subtype === 'compact_boundary'",
    );
  });

  it('Codex:contextCompaction 翻成同一形状', () => {
    const source = read('packages/maker-core/src/agents/codex/translator.ts');
    expect(source).toContain('contextCompaction');
    expect(source).toContain("type: 'compact_boundary'");
  });

  it('Pi:同样报统一事件', () => {
    expect(read('packages/maker-core/src/agents/pi/translator.ts')).toContain(
      "type: 'compact_boundary'",
    );
  });

  it('统一事件在事件类型表里', () => {
    expect(read('packages/maker-core/src/types/events.ts')).toContain("'compact_boundary'");
  });
});

describe('压缩之后伙伴的身份被重新注入', () => {
  const register = read('apps/desktop/src/main/maker-ipc/register.ts');

  it('压缩边界被记下来,而不是当场重建 —— 同一轮里可能压好几次', () => {
    expect(register).toContain("event.type === 'compact_boundary'");
    expect(register).toContain('botCompactRuntimeRefreshCoordinator.noteBoundary(session)');
  });

  it('真正的重建发生在轮次结束之后', () => {
    expect(register).toContain('botCompactRuntimeRefreshCoordinator.attempt(session)');
  });

  it('重建走 replaceBotRuntimeAfterPreflight:先预检、再确认还是当前 owner、最后才关', () => {
    // 顺序错了就会「预检失败还是把好好的 runtime 关掉了」。
    expect(register).toContain('replaceBotRuntimeAfterPreflight');
    expect(register).toContain('preflightBotRuntimeResources');
    expect(register).toContain('isCurrentOwner');
  });

  it('会话关闭时清掉待处理的边界,不给已经没了的会话重建 runtime', () => {
    expect(register).toContain('clearForClosedSession');
  });

  it('重建留痕,能查到某次压缩之后档案是哪个版本', () => {
    expect(register).toContain('compact-runtime-refresh-applied');
  });
});

describe('Hermes capability epoch', () => {
  const register = read('apps/desktop/src/main/maker-ipc/register.ts');
  const runtime = read('apps/desktop/src/main/maker-ipc/botProfileRuntime.ts');

  it('每次发送前探测 canonical Chat 的档案、Skill、MCP、Toolset 与队友名册指纹', () => {
    expect(register).toContain('refreshBotCapabilityEpochBeforeSend');
    expect(register.match(/refreshBotCapabilityEpochBeforeSend\(compactedRuntime\)/g)).toHaveLength(2);
    expect(runtime).toContain('runtimeEpochSha256');
    expect(runtime).toContain('contextPrompt: opts.botProfileContextPrompt');
  });

  it('只有指纹变化才复用安全的原地 runtime 重建，不换 canonical Session id', () => {
    expect(register).toContain('if (!snapshot?.runtimeEpochChanged) return');
    expect(register).toContain('botCompactRuntimeRefreshCoordinator.noteBoundary(live)');
    expect(register).toContain('maker.getSession(expectedSession.id) === expectedSession');
  });

  it('后台 epoch 刷新失败会被主进程收口，不产生未处理的 Promise 拒绝', () => {
    expect(register).toContain('Bot runtime capability epoch refresh failed');
  });
});

describe('压缩不换会话', () => {
  it('重建用的是同一条会话 id —— 侧栏、作品集、右栏都不会因为压缩而断掉', () => {
    // 这一条是「不抄 Hermes 续接链」的立身之本:换 id 才需要链。
    expect(read('apps/desktop/src/main/maker-ipc/register.ts')).toContain(
      'maker.getSession(expectedSession.id) === expectedSession',
    );
  });

  it('仓库里没有第二套「压缩后跟到子会话」的链式解析', () => {
    // Hermes 那条链的形状是 compression tip / continuation chain。Cindy 不该有。
    const coordinator = read('apps/desktop/src/main/maker-ipc/botCompactRuntimeRefresh.ts');
    expect(coordinator).not.toContain('compressionTip');
    expect(coordinator).not.toContain('continuationChain');
  });
});
