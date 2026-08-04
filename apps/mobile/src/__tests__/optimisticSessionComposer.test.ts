/**
 * 会话参数未就绪(新建在途 / 缓存种入)时 composer 保持正常,发送走 outbox 排队。
 *
 * 这两种状态原先经 buildSessionOperationLayout 的 readOnlyReason 进来,共享模型据此把
 * 整个输入框换成「只读模式」卡片——每次新建会话都必然经过几秒,观感是「刚发出消息就
 * 变只读」。现在 composer 全程可用,派发由 outboxDispatchBlockedNow 挡住,就绪后自动
 * pump;顺序靠「sendAtMs 在 dispatch 时才生成」保证(见 newSessionCreation.ts 的
 * sendAtMs 注释)。
 *
 * mobile 没有组件渲染测试设施(惯例见 chatQuoteCrossDevice.test.ts),这里做源码级接线
 * 断言:门在该在的位置、失败路径不放行、设置类 RPC 仍被挡。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const SCREEN = 'app/sessions/[sessionId].tsx';

describe('mobile optimistic composer while session is not ready', () => {
  it('keeps the composer out of the read-only slot and only gates queue rows', () => {
    const source = readSource(SCREEN);

    // composer 只认真正的协作只读理由。
    expect(source).toContain('      readOnlyReason: composerReadOnlyReason,\n');
    expect(source).not.toContain('readOnlyReason: cacheSeededReason');
    // 队列行(取消 / 编辑 / 插队都是打到被控端队列的 RPC)仍然只读。
    expect(source).toContain('const queueInlineReadOnlyReason = collaborationReadOnlyReason\n    ?? cacheSeededReason\n    ?? pendingCreationReason');
  });

  it('blocks outbox dispatch until the session row can actually be sent with', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const outboxDispatchBlockedNow = () => {');
    // 「会话在被控端还不存在」走共用判据(见下方的入口收敛测试);派发还额外要求字段
    // 权威(cacheSeeded 行被瘦身截断过)与创建管线已收口。
    expect(source).toContain('if (isRemoteSessionMissing(row)) return true;');
    expect(source).toContain('if (row?.cacheSeeded) return true;');
    expect(source).toContain('return getNewSessionCreationTask(sessionId) !== null;');
    // pump 循环每轮都看当下真相,blocked 时留住条目(不标失败)。
    expect(source).toContain('if (outboxDispatchBlockedNow()) return;');
    // 解禁那一帧重新 pump。
    expect(source).toContain('const outboxDispatchBlocked = !currentSession');
    expect(source).toContain('if (outboxDispatchBlocked) return;\n    void pumpOutbox();');
  });

  it('routes sends through the outbox while blocked and defers the workingDir check', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const dispatchBlockedAtSend = outboxDispatchBlockedNow();');
    expect(source).toContain('|| dispatchBlockedAtSend)) {');
    // dialogue 会话的 workingDir 由被控端在创建时分配,合成行此刻为空 —— 校验推迟到
    // dispatch(那时会重读 store 拿权威值),否则新建对话发消息会被误判成缺工作目录。
    expect(source).toContain('if (!dispatchBlockedAtSend && !currentSession.workingDir) {');
  });

  it('recovers the first message and the follow-ups together, in order', () => {
    // 「首条回输入框 + 后续留在 outbox」是不可恢复的:重试失败的 outbox 条目会把后续消息
    // 发到首条前面,重发首条又会追加到失败条目之后被挡住,原顺序拼不回来(review P1)。
    // 两者必须一起、按序进同一份草稿,首条在前。
    const source = readSource(SCREEN);
    const branchStart = source.indexOf("if (status === 'enqueue-failed') {");
    const branchEnd = source.indexOf('void load();', branchStart);
    const branch = source.slice(branchStart, branchEnd);

    expect(branch).toContain("takeOutboxForSession(sessionId, 'release-to-tray')");
    expect(branch).toContain('restoreRecoverableItemsToDraft(sessionId, recoverables)');
    // 首条排在后续消息之前。
    expect(branch.indexOf('text: restoredText,')).toBeLessThan(branch.indexOf('...followUps,'));
    // 取走 outbox 必须发生在 dismiss 之前:dismiss 会解禁派发门。
    expect(branch.indexOf('takeOutboxForSession'))
      .toBeLessThan(branch.indexOf('dismissNewSessionCreation(sessionId)'));
    // 附件走统一收尾;task 已被消费的竞态分支同样要恢复附件(原先只恢复了文本)。
    expect(branch).toContain('adoptRecoveredAttachments(creationTask.attachments, followUps)');
    expect(branch).toContain('adoptRecoveredAttachments([], followUps)');
  });

  it('hands in-flight uploads back to the tray instead of cancelling them', () => {
    // 留在本页时,在途 / 失败的上传任务必须交还 composer 托盘:取消重传是错的——用户已经
    // 等过一次上传,粘贴来源的本地文件此时可能已被回收,连重选都做不到(review P1)。
    const source = readSource(SCREEN);
    const fnStart = source.indexOf('const takeOutboxForSession = (');
    const fnEnd = source.indexOf('\n  };', fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toContain("uploads: 'release-to-tray' | 'cancel',");
    expect(fn).toContain('releaseClaimedUploads(pendingLocalIds);');
    // cancel 分支必须把「没能保住多少」报给调用方,不能悄悄取消。
    expect(fn).toContain('cancelledUploadCount: pendingLocalIds.length');
  });

  it('carries follow-ups back to the new-session screen when creation itself failed', () => {
    // create-failed 的「返回编辑」会连合成会话行一起删掉:不把 outbox 一并 stash,
    // unmount cleanup 会把那些消息写进一个即将消失的会话草稿,用户再也找不回(review P1)。
    const source = readSource(SCREEN);
    const backToEditStart = source.indexOf("text: t('session.screen.backToEdit')");
    const backToEditEnd = source.indexOf("text: t('session.screen.retry')", backToEditStart);
    const branch = source.slice(backToEditStart, backToEditEnd);
    // 跨页导航:upload controller 随会话页销毁,在途上传保不住,只能取消 + 告知。
    expect(branch).toContain("takeOutboxForSession(sessionId, 'cancel')");
    expect(branch.indexOf('takeOutboxForSession'))
      .toBeLessThan(branch.indexOf('dismissNewSessionCreation(sessionId, { removeSyntheticRow: true })'));
    expect(branch).toContain('outboxItemDraftText');
    // 装不下的中转对象回收 + 把「没能带回多少」随 stash 带到新建页。
    expect(branch).toContain('discardRecoveredAttachments(dropped);');
    expect(branch).toContain('const unrecoveredCount = dropped.length + cancelledUploadCount;');
    expect(branch).toContain("notice: unrecoveredCount > 0");
  });

  it('never silently drops recovered attachments, and never discards live tray ones', () => {
    // 一条草稿装不下 N 条消息的附件时,溢出不可避免;两条铁律:不静默丢(回收中转对象 +
    // 告知),不删活的(discard 只落在没进托盘的附件上,review P1 收敛检查点)。
    const source = readSource(SCREEN);
    const fnStart = source.indexOf('const adoptRecoveredAttachments = (');
    const fnEnd = source.indexOf('\n  };', fnStart);
    const fn = source.slice(fnStart, fnEnd);
    // 取舍顺序:托盘已有 > 首条消息 > 后续消息。
    expect(fn).toContain('mergeAttachmentsWithinLimit(attachmentsRef.current, firstMessageAttachments)');
    expect(fn).toContain('mergeAttachmentsWithinLimit(withFirst.merged, followUpAttachments)');
    expect(fn).toContain('const dropped = [...withFirst.dropped, ...withFollowUps.dropped];');
    expect(fn).toContain('discardRecoveredAttachments(dropped);');
    expect(fn).toContain("setAttachmentError(t('session.screen.attachmentsNotCarriedBack'");
    // 判据只有一份:上限 / 去重逻辑在 attachments.ts,screen 里不再内联复制。
    expect(source).not.toContain('if (merged.length >= MOBILE_MAX_ATTACHMENTS) break;');
  });

  it('keeps every input of the settling derivation visible to its memo', () => {
    // render 阶段现算的落定项,输入必须全部出现在依赖里。基线放可变 ref 时它推进不触发
    // 重算,memo 会带着「上一次转移」的答案继续活着:队首被其它控制端删除 / 被 /clear
    // 消化时,10s 超时把条目移出 settlingQueueItems 后过期缓存又把它加回来,转圈永不停
    // (review P1)。所以基线与「本地已删」都必须是 state。
    const screen = readSource(SCREEN);
    expect(screen).toContain('const [settlingBaselineState, setSettlingBaseline] = useState<{');
    expect(screen).toContain('const [locallyRemovedQueueClientIds, setLocallyRemovedQueueClientIds]');
    expect(screen).not.toContain('prevPendingQueueRef');
    expect(screen).not.toContain('locallyRemovedQueueClientIdsRef');
    const memoStart = screen.indexOf('const derivedSettlingItems = useMemo(');
    const memoEnd = screen.indexOf('\n  );', memoStart);
    const memo = screen.slice(memoStart, memoEnd);
    expect(memo).toContain('previous: settlingBaseline.queue,');
    expect(memo).toContain('locallyRemovedClientIds: locallyRemovedQueueClientIds,');
    // 依赖 ⊇ 输入。
    const deps = memo.slice(memo.indexOf('}),') + 3);
    for (const dep of ['settlingBaseline', 'locallyRemovedQueueClientIds', 'queueHiddenClientIds']) {
      expect(deps).toContain(dep);
    }
    // 自激防护:基线已是本帧 projection 时 layout effect 直接返回,否则 setState 会让
    // 自己的依赖再次变化。
    expect(screen).toContain('settlingBaseline.queue === inputProjection.pendingQueue');
    // 「不该再画」的判据只有一份,render 过滤与 effect 摘除共用;本地删除标记晚一帧到达
    // 时也能自愈(state 化后写入不再同步)。
    expect(screen).toContain('const settlingRetired = useCallback(');
    expect(screen).toContain('const next = current.filter((item) => !settlingRetired(item.clientId));');
    expect(screen).toContain('settlingQueueItems.filter((item) => !settlingRetired(item.clientId)),');
  });

  it('never renders the previous session\'s settling bubbles after an in-place switch', () => {
    // 同一个 SessionScreen 实例会原地从会话 A 切到 B,而清理是**被动** effect(layout
    // effect 先跑、它后跑):清理落地前 B 的首帧会照着 A 的基线与残留画气泡,用户会在 B 里
    // 看到一瞬间 A 的消息内容(review P1)。落定集合与基线都带归属会话,读侧先核身份,
    // 时序不再影响正确性。
    const screen = readSource(SCREEN);
    // 状态本体带 sessionId。
    expect(screen).toContain('const [settlingState, setSettlingState] = useState<{\n    sessionId: string;');
    expect(screen).toContain('const [settlingBaselineState, setSettlingBaseline] = useState<{\n    sessionId: string;');
    // 读侧核身份,不匹配即视为空。
    expect(screen).toContain('const settlingQueueItems = settlingState.sessionId === sessionId ? settlingState.items : EMPTY_SETTLING_ITEMS;');
    expect(screen).toContain('const settlingBaseline = settlingBaselineState.sessionId === sessionId\n    ? settlingBaselineState\n    : EMPTY_SETTLING_BASELINE;');
    // 写侧同样先核身份:不把 A 的条目并进 B。
    expect(screen).toContain('const base = current.sessionId === sessionId ? current.items : EMPTY_SETTLING_ITEMS;');
    // 空值是模块级常量:引用稳定,不让 memo 每帧失效。
    expect(screen).toContain('const EMPTY_SETTLING_ITEMS: readonly QueuedRemoteMessage[] = [];');
    // 写入器按 sessionId 记账,必须进各 effect 依赖,否则切会话那帧可能用旧写入器
    // 把新会话的集合覆盖掉。
    const writerDeps = screen.split('setSettlingQueueItems,').length - 1;
    expect(writerDeps).toBeGreaterThanOrEqual(3);
  });

  it('locks the agent-switch writer, not just the runControlAction callers', () => {
    // 换模型走的是 selectComposerModelRow → writeSessionAgentSwitchIntent,不经
    // runControlAction:只在后者加锁就漏了它,而被控端的 switch handler 要求会话行已存在,
    // 合成行阶段一律 NOT_FOUND(review P1)。门放在唯一出口,新增入口不会再漏。
    const screen = readSource(SCREEN);
    const fnStart = screen.indexOf('const writeSessionAgentSwitchIntent = useCallback(async (');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = screen.indexOf('  }, [controlBusy, deviceId, maker, sessionId', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = screen.slice(fnStart, fnEnd);
    expect(fn).toContain('if (sessionSettingsLocked) return false;');
    // 锁进依赖,回调不会停留在「未锁」那一帧。
    expect(screen).toContain('}, [controlBusy, deviceId, maker, sessionId, sessionSettingsLocked]);');
  });

  it('binds sticky/locked derived state to the thing it belongs to', () => {
    // 同一族的两处泄漏:活动条粘滞态跨会话、缩略图锁定跨附件变更 —— 派生状态不带身份,
    // 切换目标时旧值会顶着新目标(review P1/P2)。
    const screen = readSource(SCREEN);
    expect(screen).toContain('const showComposerActivity = isSessionStreaming || streamingSticky === sessionId;');

    const bubble = readSource('src/session/PendingSendBubble.tsx');
    expect(bubble).toContain("const identity = `${thumb.uri ?? ''}|${thumb.ossRef ?? ''}`;");
    expect(bubble).toContain("const shown = shownRef.current?.identity === identity ? shownRef.current.uri : null;");
    expect(bubble).toContain('remoteState?.identity === identity ? remoteState.uri : null');
  });

  it('routes every remote-session-dependent entry through one judgement', () => {
    // 「会话在被控端还不存在」原先只在会话设置那一处写了,slash 命令那条路漏了:创建
    // 窗口内发 /context 会直接打 RPC,消费掉草稿再糊一张错误卡(review P1)。判据收敛
    // 成一个纯函数,三类入口共用——渲染用 reactive 形态,命令式路径读 store 同步真源。
    const source = readSource(SCREEN);

    expect(source).toContain('function isRemoteSessionMissing(row: RemoteSession | null | undefined): boolean {');
    expect(source).toContain('return !row || row.pendingLocalCreation === true;');
    // 1) 渲染:按钮灰态。
    expect(source).toContain('const sessionSettingsLocked = isRemoteSessionMissing(currentSession);');
    expect(source).toContain('disabled={!canUseComposer || controlBusy || sessionSettingsLocked}');
    // 2) 会话设置 RPC 的硬门(统一入口,覆盖全部 runControlAction 调用点)。
    expect(source).toContain('if (sessionSettingsLocked) return;\n    setControlBusy(true);');
    // 3) 消息派发:复合判据,「不存在」是它的子集。
    expect(source).toContain('if (isRemoteSessionMissing(row)) return true;');
    expect(source).not.toContain('const sessionSettingsLocked = currentSession?.pendingLocalCreation === true;');
  });

  it('blocks remote-backed slash commands before the draft is consumed', () => {
    // 挡住而不是排队:outbox 的派发动作是「enqueue 一条消息」,命令原样入队 agent 只会
    // 当普通文本忽略。而且必须挡在乐观清空**之前**,否则草稿已经没了,提示再准确也
    // 救不回用户打的字(review P1)。
    const source = readSource(SCREEN);
    const gate = source.indexOf('commandNeedsRemoteSession(earlyLocalCommand, earlyDesktopCommand)');
    expect(gate).toBeGreaterThan(-1);
    const clear = source.indexOf('if (text) applyComposerDocument(documentAfterOptimisticClear);');
    expect(gate).toBeLessThan(clear);
    const branch = source.slice(gate, clear);
    expect(branch).toContain('isRemoteSessionMissing(readSessionRowNow())');
    expect(branch).toContain("setError(t('session.screen.commandWaitsForSession'));");
    // 早退必须自己解掉发送锁(这一段在 try/finally 之前)。
    expect(branch).toContain('sendInFlightRef.current = false;');
    expect(branch).toContain('setSending(false);');
  });
});
