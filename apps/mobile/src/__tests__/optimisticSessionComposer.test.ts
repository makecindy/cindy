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
    expect(source).toContain('if (row.cacheSeeded) return true;');
    expect(source).toContain('if (row.pendingLocalCreation) return true;');
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
    expect(screen).toContain('const [settlingBaseline, setSettlingBaseline] = useState<{');
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

  it('still blocks session-settings RPCs until the session exists remotely', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const sessionSettingsLocked = currentSession?.pendingLocalCreation === true;');
    // 硬门在统一入口,覆盖全部 runControlAction 调用点。
    expect(source).toContain('if (sessionSettingsLocked) return;\n    setControlBusy(true);');
    expect(source).toContain('disabled={!canUseComposer || controlBusy || sessionSettingsLocked}');
  });
});
