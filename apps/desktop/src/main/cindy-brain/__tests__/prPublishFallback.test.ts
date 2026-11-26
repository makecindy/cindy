/**
 * prPublishFallback.test.ts — Turn-end fallback for missed `cindy-github` `pr_card(published: true)`.
 *
 * 测试价值
 * - 生产入口与可观察结果：调用 isGhPrCreateCommand、TurnPrPublishTracker 与 runPublishedPrCardFallback；
 *   验证正常完成且通过 `gh pr create` 创建了 GitHub PR 却漏调 `pr_card` 的轮次会补调
 *   `cindy-github` `pr_card(published: true)`（附带 session_context 与 cardService 登记/收口），
 *   而普通 PR 链接、已调 `pr_card`、失败/中断轮次、远程会话、插件未就绪或切号后均不误触发。
 * - Bug／规则依据：真实长轮次任务创建 PR #12736 后跳过 `pr_card(published: true)` 导致自动跟进未启动。
 * - 现有覆盖缺口：相邻测试（assistantReplyHook.test.ts、prRefsStore.test.ts）只测回复重写与链接提取，
 *   未覆盖 `gh pr create` 强信号追踪与漏调 `pr_card` 的 turn-end 兜底编排。
 * - 最小失败输入：轮次内 exec 执行 `gh pr create` 输出 PR URL 后直接 `done`，不调 `pr_card`。
 * - tier：unit（纯内存依赖注入，无真实网络/子进程/Electron）。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isGhPrCreateCommand,
  TurnPrPublishTracker,
  runPublishedPrCardFallback,
  type PrPublishFallbackDeps,
  type PrPublishFallbackSessionSnapshot,
  type PrPublishFallbackTarget,
} from '../prPublishFallback.js';

describe('isGhPrCreateCommand', () => {
  it.each([
    ['gh pr create --base main --head fix/a --title "fix"', true],
    ['git push -u origin fix/a && gh pr create --fill', true],
    ['PR_URL=$(gh pr create --base main --head fix/a)', true],
    ["/bin/zsh -lc \"cat > /tmp/pr.md <<'EOF'\nbody\nEOF\ngh pr create --base main --body-file /tmp/pr.md\"", true],
    ['/bin/zsh -lc \'GH_HOST=github.com gh pr create --base main\'', true],
    ['gh pr view https://github.com/makecindy/cindy/pull/12736', false],
    ['gh pr checks https://github.com/makecindy/cindy/pull/12736', false],
    ['gh pr create --help', false],
    ['gh pr create --dry-run --title "test"', false],
    ['echo "gh pr create --base main"', false],
    ['git grep "gh pr create"', false],
  ])('command %j -> %s', (command, expected) => {
    expect(isGhPrCreateCommand(command)).toBe(expected);
  });
});

describe('TurnPrPublishTracker', () => {
  it('returns newly created GitHub PR when turn completes without pr_card', () => {
    const tracker = new TurnPrPublishTracker();
    tracker.beginTurn();
    tracker.handleEvent({
      type: 'tool_use',
      source: 'codex',
      data: {
        toolUseId: 'exec-1',
        toolName: 'exec',
        input: { command: "/bin/zsh -lc 'gh pr create --base main --head fix/relink --title fix'" },
      },
    });
    tracker.handleEvent({
      type: 'tool_result_full',
      source: 'codex',
      data: {
        toolUseId: 'exec-1',
        fullText: 'https://github.com/makecindy/cindy/pull/12736\n',
        isError: false,
      },
    });

    const unhandled = tracker.finishTurn(true);
    expect(unhandled).toEqual([
      {
        owner: 'makecindy',
        repo: 'cindy',
        prNumber: 12736,
        url: 'https://github.com/makecindy/cindy/pull/12736',
      },
    ]);
    // Subsequent turn starts clean.
    expect(tracker.finishTurn(true)).toEqual([]);
  });

  it('suppresses fallback when cindy-github pr_card succeeded after gh pr create', () => {
    const tracker = new TurnPrPublishTracker();
    tracker.beginTurn();
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'bash-1', toolName: 'Bash', input: { command: 'gh pr create --fill' } },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['bash-1'], summary: 'https://github.com/makecindy/cindy/pull/12736' },
    });
    tracker.handleEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'ghost-1',
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'cindy-github',
          tool: 'pr_card',
          args: { repo: 'makecindy/cindy', pr: '12736', published: true },
        },
      },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['ghost-1'], summary: '{"ok":true,"result":{"card_id":"c1","follow_state":"active"}}' },
    });

    expect(tracker.finishTurn(true)).toEqual([]);
  });

  it('does not suppress fallback when only a pre-publish ask pr_card ran before gh pr create', () => {
    const tracker = new TurnPrPublishTracker();
    tracker.beginTurn();
    tracker.handleEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'ask-card',
        toolName: 'mcp__cindy__ghost_call',
        input: {
          ghost_id: 'cindy-github',
          tool: 'pr_card',
          args: { repo: 'makecindy/cindy', head: 'fix/a', base: 'main' },
        },
      },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['ask-card'], summary: '{"ok":true,"result":{"card_id":"c1","stage":"ask"}}' },
    });
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'create-1', toolName: 'Bash', input: { command: 'gh pr create --fill' } },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['create-1'], summary: 'https://github.com/makecindy/cindy/pull/42' },
    });

    expect(tracker.finishTurn(true).map((r) => r.prNumber)).toEqual([42]);
  });

  it('ignores non-create commands, failed creates, failed pr_card, and interrupted turns', () => {
    const tracker = new TurnPrPublishTracker();
    tracker.beginTurn();
    // Ordinary gh pr view is not creation
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'v1', toolName: 'Bash', input: { command: 'gh pr view 12736' } },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['v1'], summary: 'https://github.com/makecindy/cindy/pull/12736' },
    });
    // Failed gh pr create
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'c-err', toolName: 'Bash', input: { command: 'gh pr create --fill' } },
    });
    tracker.handleEvent({
      type: 'tool_result_full',
      data: {
        toolUseId: 'c-err',
        fullText: '<tool_use_error>pull request already exists: https://github.com/makecindy/cindy/pull/99</tool_use_error>',
        isError: true,
      },
    });
    expect(tracker.finishTurn(true)).toEqual([]);

    // Interrupted turn discards created PR
    tracker.beginTurn();
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'c-ok', toolName: 'Bash', input: { command: 'gh pr create --fill' } },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['c-ok'], summary: 'https://github.com/makecindy/cindy/pull/100' },
    });
    expect(tracker.finishTurn(false)).toEqual([]);

    // Failed pr_card after create does NOT mask fallback
    tracker.beginTurn();
    tracker.handleEvent({
      type: 'tool_use',
      data: { toolUseId: 'c-ok2', toolName: 'Bash', input: { command: 'gh pr create --fill' } },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['c-ok2'], summary: 'https://github.com/makecindy/cindy/pull/101' },
    });
    tracker.handleEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'g-err',
        toolName: 'mcp:cindy:ghost_call',
        input: { ghost_id: 'cindy-github', tool: 'pr_card', args: { repo: 'makecindy/cindy', pr: '101', published: true } },
      },
    });
    tracker.handleEvent({
      type: 'tool_result',
      data: { toolUseIds: ['g-err'], summary: '{"ok":false,"errorCode":"INTERNAL"}' },
    });
    expect(tracker.finishTurn(true).map((r) => r.prNumber)).toEqual([101]);
  });
});

describe('runPublishedPrCardFallback', () => {
  const samplePr = {
    owner: 'makecindy',
    repo: 'cindy',
    prNumber: 12736,
    url: 'https://github.com/makecindy/cindy/pull/12736',
  };

  function makeDeps(overrides: Partial<PrPublishFallbackDeps> = {}) {
    const target: PrPublishFallbackTarget = {
      instanceId: 'cindy-github',
      logicalGhostId: 'cindy-github',
      wantsSessionContext: true,
    };
    const snapshot: PrPublishFallbackSessionSnapshot = {
      workingDir: '/Users/test/repo',
      remoteHostId: null,
      workdirIsReadOnly: false,
    };
    const registerCardCall = vi.fn();
    const finalizeCardCall = vi.fn();
    const callPrCard = vi.fn(async () => ({ ok: true, result: { follow_state: 'active' } }));
    const deps: PrPublishFallbackDeps = {
      isCurrent: () => true,
      getSessionSnapshot: vi.fn(async () => snapshot),
      resolveGithubTarget: vi.fn(async () => target),
      buildSessionContext: vi.fn((sid) => ({ session_id: sid, workdir_is_local: true, workdir_is_read_only: false })),
      registerCardCall,
      finalizeCardCall,
      callPrCard,
      createCallId: () => 'fallback-call-1',
      log: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    };
    return { deps, registerCardCall, finalizeCardCall, callPrCard };
  }

  it('registers call, passes published=true and session_context, and always finalizes', async () => {
    const { deps, registerCardCall, finalizeCardCall, callPrCard } = makeDeps();
    await runPublishedPrCardFallback(deps, 'sess-1', [samplePr]);

    expect(registerCardCall).toHaveBeenCalledWith('fallback-call-1', expect.objectContaining({ instanceId: 'cindy-github' }), 'sess-1');
    expect(callPrCard).toHaveBeenCalledWith({
      instanceId: 'cindy-github',
      callId: 'fallback-call-1',
      sessionId: 'sess-1',
      args: {
        repo: 'makecindy/cindy',
        pr: '12736',
        published: true,
        session_context: { session_id: 'sess-1', workdir_is_local: true, workdir_is_read_only: false },
      },
    });
    expect(finalizeCardCall).toHaveBeenCalledWith('fallback-call-1');
  });

  it('skips remote SSH sessions, unavailable plugin targets, and stale owners without dispatching', async () => {
    const remote = makeDeps({
      getSessionSnapshot: vi.fn(async () => ({
        workingDir: '/remote/repo',
        remoteHostId: 'ssh-1',
        workdirIsReadOnly: false,
      })),
    });
    await runPublishedPrCardFallback(remote.deps, 'sess-remote', [samplePr]);
    expect(remote.callPrCard).not.toHaveBeenCalled();

    const noPlugin = makeDeps({ resolveGithubTarget: vi.fn(async () => null) });
    await runPublishedPrCardFallback(noPlugin.deps, 'sess-no-plugin', [samplePr]);
    expect(noPlugin.callPrCard).not.toHaveBeenCalled();

    const staleOwner = makeDeps({ isCurrent: () => false });
    await runPublishedPrCardFallback(staleOwner.deps, 'sess-stale', [samplePr]);
    expect(staleOwner.callPrCard).not.toHaveBeenCalled();
  });

  it('finalizes card call and stays fail-open when pr_card throws', async () => {
    const { deps, finalizeCardCall } = makeDeps({
      callPrCard: vi.fn(async () => { throw new Error('sandbox timeout'); }),
    });
    await expect(runPublishedPrCardFallback(deps, 'sess-err', [samplePr])).resolves.toBeUndefined();
    expect(finalizeCardCall).toHaveBeenCalledWith('fallback-call-1');
    expect(deps.log?.warn).toHaveBeenCalled();
  });
});
