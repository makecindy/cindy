import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const pendingSource = readFileSync(
  resolve(__dirname, '..', 'state', 'pendingFirstMessage.ts'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('NewMakerDraftRoute local first-message send', () => {
  const localFence = source.indexOf(
    '本机首条消息在草稿路由发出,不把发送绑在 SessionView hydrate 上。',
  );

  it('sends the local first message from the draft route before navigating', () => {
    const sendMessage = source.indexOf(
      'const sendPromise = makerChatStore.sendMessage(',
      localFence,
    );
    const navigate = source.indexOf('navigateToSession();', sendMessage);

    expect(localFence).toBeGreaterThan(-1);
    expect(sendMessage).toBeGreaterThan(localFence);
    expect(navigate).toBeGreaterThan(sendMessage);
  });

  /**
   * PR #5555 的 Greptile review：「普通首条消息创建仍会补回草稿档位」。
   * ChatInput 侧有两层兜底（`initialEffort ?? localVendorDefaults.effort`、
   * `display.effort ?? 'low'`），且 `let effortForSend = activeEffort` 只在有 sessionId 时
   * 才被覆盖 —— 新建任务拿到的 effort 永远有值。若直接提交，目录已声明无档位的型号会被
   * main 准入按 `valid: none` 拒绝（新建任务必然失败、界面无档可改）。
   */
  it('提交首条消息前按最终模型能力收敛档位，不直接交 ChatInput 回传的值', () => {
    // 归一在 handleSend 入口算一次，且**复用草稿层同一个函数**（三态规则只存在一处）：
    // resolveSubmitEffort 内部即 resolveNewMakerDraftEffort，不在消费端另写一套。
    // （此断言原指向内联 IIFE `(() => {…})()`；提取成共用函数后实现形态变了 —— 源码断言
    //  绑的是实现而非行为，真正锁行为的是 newMakerDraftModelPrefs.test 里的完整发送路径。）
    expect(source).toContain('const submitEffort = resolveSubmitEffort({');
    // 档位能力按**目录能力引擎**查（与 localDraftEffort 同源），不是 DB 形态的 agentKind。
    expect(source).toContain('agentKind: capabilityAgentKind');

    // 普通与 worktree 两处 createSession（对象参数）都交归一后的值。
    expect(source.match(/effort: submitEffort,/g)?.length).toBeGreaterThanOrEqual(2);

    // 两处 sendMessage（**位置参数**，第 4 参是必填 string）交归一值，空串 = 无档位。
    expect(source.match(/submitEffort \?\? ''/g)?.length).toBeGreaterThanOrEqual(2);

    // 普通本机 createSession（该尾随片段全文唯一，位于 handleSend 内）用归一值。
    const ordinaryCreate = source.indexOf('workingDir: workingDir ?? undefined,');
    expect(ordinaryCreate).toBeGreaterThan(-1);
    expect(source.slice(ordinaryCreate - 360, ordinaryCreate)).toContain('effort: submitEffort');
  });

  it('seeds remoteHostId into chat store before the draft-route first send', () => {
    const seed = source.indexOf(
      'makerChatStore.setSessionRuntime(newSession.id, {',
      source.indexOf("workspaceKind: workingDir ? 'project' : 'dialogue'"),
    );
    const seedBlock = source.slice(seed, source.indexOf('});', seed) + 3);

    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(localFence);
    expect(seedBlock).toContain('remoteHostId: workingDir ? (effectiveRemoteHostId ?? null) : null');
  });

  it('does not register a memory-only pending payload for ordinary local text', () => {
    const localSend = source.indexOf('const sendPromise = makerChatStore.sendMessage(', localFence);
    const pendingAfterSend = source.indexOf('setPending(newSession.id', localSend);
    expect(source).toContain('setPending(remoteSessionId, {');
    expect(pendingSource).toContain(
      '本机新建的普通文本不走这里:草稿路由 createSession 后直接 sendMessage',
    );
    expect(pendingAfterSend).toBe(-1);
  });

  it('restores a rejected or thrown first send onto the created task without clobbering newer input', () => {
    const localSend = source.indexOf('const sendWorkingDir = workingDir ?? newSession.workingDir;');
    const restore = source.indexOf('const restoreFirstMessageDraft = () => {', localSend);
    const fifoRestore = source.indexOf('restoreRemoteOptimisticDraft(newSession.id, {', restore);
    const saveDraft = source.indexOf('saveComposerDraft(newSession.id, {', restore);
    const catchRestore = source.indexOf(
      'restoreFirstMessageDraft();',
      source.indexOf("log.error('[draft send]', err);", localFence),
    );
    const falseRestore = source.indexOf(
      'restoreFirstMessageDraft();',
      source.indexOf('} else {', source.indexOf('(accepted) => {', localFence)),
    );

    expect(restore).toBeGreaterThan(localSend);
    expect(fifoRestore).toBeGreaterThan(restore);
    expect(fifoRestore).toBeLessThan(catchRestore);
    expect(saveDraft).toBe(-1);
    expect(source.slice(localSend, fifoRestore)).toContain(
      'const preNavDraftDoc = opts?.recoveryDraftDoc ?? preNavDraft?.text ?? null;',
    );
    expect(source.slice(fifoRestore, catchRestore)).toContain(
      'text: preNavDraftDoc ?? plainTextToTiptapDoc(message)',
    );
    expect(source.slice(localSend, fifoRestore)).toContain(
      'rewriteBrowserCommentsFromRehomedFiles(',
    );
    expect(source.slice(fifoRestore, catchRestore)).toContain(
      'excludeCommentScreenshots(rehydratedFiles, preNavBrowserComments)',
    );
    expect(source.slice(fifoRestore, catchRestore)).toContain(
      'browserComments: preNavBrowserComments',
    );
    expect(source.slice(fifoRestore, catchRestore)).not.toContain('browserComments: []');
    expect(catchRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).toBeGreaterThan(fifoRestore);
    expect(falseRestore).not.toBe(catchRestore);
  });

  it('hands slash-looking first messages to SessionView instead of copying desktop dispatch', () => {
    const slashMatch = source.indexOf('const slashMatch = message.match(', localFence);
    const leading = source.indexOf('leadingSlashInvocation(message)', slashMatch);
    const pendingHandoff = source.indexOf('setPending(newSession.id, {', slashMatch);
    const sendPromise = source.indexOf(
      'const sendPromise = makerChatStore.sendMessage(',
      localFence,
    );
    const reviewStart = source.indexOf('window.electronAPI.maker.startReview({', localFence);

    expect(slashMatch).toBeGreaterThan(localFence);
    expect(leading).toBeGreaterThan(slashMatch);
    expect(leading).toBeLessThan(pendingHandoff);
    expect(pendingHandoff).toBeGreaterThan(slashMatch);
    expect(pendingHandoff).toBeLessThan(sendPromise);
    expect(reviewStart).toBe(-1);
    expect(source.slice(slashMatch, pendingHandoff)).toContain("capabilityAgentKind === 'pi'");
    expect(sessionViewSource).toContain('const pending = consumePending(sessionId);');
    expect(sessionViewSource).toContain('maybeDispatchDesktopSlashCommand');
    expect(sessionViewSource).toContain('leadingSlashInvocation(message)');
    expect(sessionViewSource).toContain('本机与远程的普通文本已在草稿路由发出');
  });
});
