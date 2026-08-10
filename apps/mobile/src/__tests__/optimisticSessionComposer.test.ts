/**
 * 会话参数未就绪或连接自动恢复中时 composer 保持正常,发送走 outbox 排队。
 *
 * 这两种状态原先经 buildSessionOperationLayout 的 readOnlyReason 进来,共享模型据此把
 * 整个输入框换成「只读模式」卡片——每次新建会话都必然经过几秒,观感是「刚发出消息就
 * 变只读」。现在 composer 全程可用,派发由 outboxDispatchBlockedNow 挡住,就绪后自动
 * pump;顺序靠「sendAtMs 在 dispatch 时才生成」保证(见 newSessionCreation.ts 的
 * sendAtMs 注释)。
 *
 * mobile 没有组件渲染测试设施(惯例见 chatQuoteCrossDevice.test.ts),这里做源码级接线
 * 断言:门在该在的位置、失败路径不放行,并且远程控制按 Desktop 的断线分层处理。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const SCREEN = 'app/sessions/[sessionId].tsx';

describe('mobile optimistic composer while session is not ready', () => {
  it('keeps the composer out of the read-only slot while gating remote controls separately', () => {
    const source = readSource(SCREEN);

    // composer 只认真正的协作只读理由。
    expect(source).toContain('      readOnlyReason: composerReadOnlyReason,\n');
    expect(source).not.toContain('readOnlyReason: cacheSeededReason');
    // 断线 / 弱网 / 熔断只锁 outbox 派发；确定性错误仍进共享布局锁 composer。
    expect(source).toContain('remoteUnavailableReason: composerRemoteUnavailableReason,');
    expect(source).toContain('describeRemoteComposerBlockingError(connectionError)');
    // 会话尚未在被控端建成时,队列行(取消 / 编辑 / 插队)仍然只读。
    expect(source).toContain('const queueInlineReadOnlyReason = collaborationReadOnlyReason\n    ?? cacheSeededReason\n    ?? pendingCreationReason');
  });

  it('matches Desktop control behavior during a transient disconnect', () => {
    const source = readSource(SCREEN);
    const queueGateStart = source.indexOf('const queueInlineReadOnlyReason =');
    const queueGateEnd = source.indexOf(';', queueGateStart);
    const queueGate = source.slice(queueGateStart, queueGateEnd);
    const stopStart = source.indexOf('const stopSession = () => {');
    const stopEnd = source.indexOf('\n  };', stopStart);
    const stop = source.slice(stopStart, stopEnd);
    const stopButtonStart = source.indexOf('const renderComposerStopButton = () => (');
    const stopButtonEnd = source.indexOf('\n  );', stopButtonStart);
    const stopButton = source.slice(stopButtonStart, stopButtonEnd);

    // 模型 / effort / fast / 权限 / plan / Stop 都需要实时访问被控端，明确断线时禁用。
    expect(source).toContain('const sessionSettingsLocked = isRemoteSessionMissing(currentSession);');
    expect(source).toContain("const remoteRealtimeControlsUnavailable = status !== 'online'");
    expect(source).toContain('const canUseRemoteSessionControls = canUseComposer\n    && !sessionSettingsLocked\n    && !remoteRealtimeControlsUnavailable;');
    // UI error 可独立清理；transport hold 只在权威 sync 成功后解除，不再借共享 error
    // 充当 outbox 门禁。
    expect(source).toContain('const [outboxTransportHold, setOutboxTransportHold] = useState<');
    expect(source).toContain(
      'const activeOutboxTransportError = connectionError === null\n'
      + '    ? heldOutboxTransportError\n'
      + '    : screenAutoRecoveringError;',
    );
    expect(source).toContain('error: string | null;');
    expect(source).toContain('const latchOutboxTransportHold = useCallback(');
    expect(source).toContain('const outboxRecoverySyncHeld = hasLatchedOutboxTransportHold');
    expect(source).toContain('autoRecoveringError: outboxRecoverySyncHeld,');
    expect(source).toContain('setOutboxTransportHold((current) => current?.deviceId === deviceId ? null : current);');
    expect(source).not.toContain('autoRecoveringError: isAutoRecoveringRemoteError(connectionError),');
    // Desktop 断线时仍允许尝试队列编辑类动作,不把整行切成只读。
    expect(queueGate).not.toContain('remoteUnavailableReason');
    expect(queueGate).not.toContain('outboxConnectionDispatchBlocked');
    // Stop 保持可见,但明确断线时不发送 RPC,只进入自动恢复提示。
    expect(source).toContain("const remoteRealtimeControlsUnavailable = status !== 'online'");
    const dispatchPresenceStart = source.indexOf('const targetAvailableForDispatch =');
    const dispatchPresenceEnd = source.indexOf(';', dispatchPresenceStart);
    const dispatchPresence = source.slice(dispatchPresenceStart, dispatchPresenceEnd);
    expect(dispatchPresence).toContain('getPresenceAvailability(deviceId)');
    expect(dispatchPresence).not.toContain('lastPresenceSnapshot');
    expect(dispatchPresence).not.toContain('targetAvailableRef');
    expect(source).toContain('canStop: canStopComposer,');
    expect(source).toContain(
      'const composerStopDisabled = composerLayout.stop.disabled || !canUseRemoteSessionControls;',
    );
    expect(stopButton).toContain('disabled={composerStopDisabled}');
    expect(stop).toContain('if (remoteStopUnavailable) {');
    expect(stop).toContain("'[DEVICE_OFFLINE]'");
    expect(stop).toContain("'[NOT_CONNECTED]'");
    expect(stop).not.toContain('target device unavailable');
    expect(stop).not.toContain('relay reconnecting');
    const runtimePillStart = source.indexOf('function ComposerRuntimePill({');
    const runtimePillEnd = source.indexOf('\nfunction ComposerActivityStatus', runtimePillStart);
    const runtimePill = source.slice(runtimePillStart, runtimePillEnd);
    expect(runtimePill).toContain('disabled = false,');
    expect(runtimePill).toContain('disabled={disabled}');
  });

  it('publishes every transport-side presence availability transition to context consumers', () => {
    const source = readSource('src/device-link/DeviceLinkContext.tsx');
    const helperStart = source.indexOf('const publishPresenceAvailabilityMutation =');
    const helperEnd = source.indexOf('\n\n  const sendOpenLinkOnce', helperStart);
    const helper = source.slice(helperStart, helperEnd);

    expect(helper).toContain('const before = availabilityByDevice.get(deviceId) ?? null;');
    expect(helper).toContain('const after = availabilityByDevice.get(deviceId) ?? null;');
    expect(helper).toContain('if (before !== after) setPresenceVersion((version) => version + 1);');
    expect(source).not.toContain('presenceAvailableByDeviceRef.current.set');
    expect((source.match(
      /publishPresenceAvailabilityMutation\(deviceId, \(availabilityByDevice\) =>/g,
    ) ?? [])).toHaveLength(5);
    expect(source).toContain('setConnectionEpoch((n) => n + 1);');
    expect(source).toContain('setPresenceVersion((n) => n + 1);\n      const presence = updatePresenceAvailability(');
  });

  it('blocks outbox dispatch until the session row can actually be sent with', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const outboxDispatchBlockedNow = () => {');
    expect(source).toContain('if (outboxConnectionBlockedNow()) return true;');
    // 「会话在被控端还不存在」走共用判据(见下方的入口收敛测试);派发还额外要求字段
    // 权威(cacheSeeded 行被瘦身截断过)与创建管线已收口。
    expect(source).toContain('if (isRemoteSessionMissing(row)) return true;');
    expect(source).toContain('if (row?.cacheSeeded) return true;');
    expect(source).toContain('return getNewSessionCreationTask(sessionId) !== null;');
    // pump 循环每轮都看当下真相,blocked 时留住条目(不标失败)。
    expect(source).toContain('if (outboxDispatchBlockedNow()) return;');
    // 解禁那一帧重新 pump。
    expect(source).toContain('const outboxDispatchBlocked = !currentSession');
    expect(source).toContain('|| outboxConnectionDispatchBlocked;');
    expect(source).toContain('if (outboxDispatchBlocked) return;\n    void pumpOutbox();');
    // 即使 blocked boolean 恰好没变化，新的连接 epoch 也要重新唤醒一次。
    expect(source).toContain('}, [connectionEpoch, outboxDispatchBlocked]);');
  });

  it('latches every connection recovery edge until authoritative sync succeeds', () => {
    const source = readSource(SCREEN);
    const latchStart = source.indexOf('// 连接阻塞一旦出现就锁存。');
    const latch = source.slice(latchStart, source.indexOf('// 对齐 Desktop', latchStart));
    const syncStart = source.indexOf('const syncSession = useCallback(async');
    const syncCatchStart = source.indexOf('    } catch (err) {', syncStart);
    const syncCatchEnd = source.indexOf('    } finally {', syncCatchStart);
    const syncCatch = source.slice(syncCatchStart, syncCatchEnd);
    const epochEffectStart = source.indexOf("if (status !== 'online') return;", syncCatchEnd);
    const epochEffect = source.slice(epochEffectStart, source.indexOf('\n  },', epochEffectStart));
    const presenceEffectStart = source.indexOf(
      'const sameDevice = targetAvailableDeviceRef.current === deviceId',
      epochEffectStart,
    );
    const presenceEffect = source.slice(
      presenceEffectStart,
      source.indexOf('\n  },', presenceEffectStart),
    );
    const syncIdentityStart = source.indexOf('const remoteSyncContextKey = JSON.stringify([');
    const syncIdentity = source.slice(syncIdentityStart, source.indexOf(']);', syncIdentityStart));

    expect(latch).toContain('useLayoutEffect(() => {');
    expect(latch).toContain("status !== 'online'");
    expect(latch).toContain('targetAvailableForDispatch === false');
    expect(latch).toContain('|| isDeviceUnresponsive');
    expect(latch).toContain('|| screenAutoRecoveringError !== null');
    expect(latch).toContain('latchOutboxTransportHold(screenAutoRecoveringError);');
    expect(latch).toContain('syncedConnectionEpochRef.current !== connectionEpoch');
    expect(latch).toContain('targetAvailableRef.current !== true');
    expect(syncIdentity).toMatch(
      /deviceId[\s\S]*sessionId[\s\S]*connectionEpoch[\s\S]*status[\s\S]*targetAvailableForDispatch[\s\S]*isDeviceUnresponsive/,
    );
    expect(source).toContain('(run) => syncSession(run),\n    remoteSyncContextKey,');
    expect(epochEffect.indexOf('latchOutboxTransportHold(null);'))
      .toBeLessThan(epochEffect.indexOf('void load();'));
    expect(presenceEffect.indexOf('latchOutboxTransportHold(null);'))
      .toBeLessThan(presenceEffect.indexOf('void load();'));
    expect(presenceEffect).toContain('wasAvailable !== true');
    expect(presenceEffect).toContain('if (sameDevice) void load();');
    expect(source).not.toContain('lastPresenceSnapshot');
    expect((source.match(
      /setOutboxTransportHold\(\(current\) => current\?\.deviceId === deviceId \? null : current\);/g,
    ) ?? [])).toHaveLength(1);
    expect(syncCatch).toContain('latchOutboxTransportHold(formatted);');
    expect(syncCatch).not.toContain('if (isAutoRecoveringRemoteError(err))');
    expect(syncCatch).not.toContain('setOutboxTransportHold(');
    expect(syncCatch).not.toContain('? null : current');
  });

  it('routes sends through the outbox while blocked and defers the workingDir check', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const dispatchBlockedAtSend = outboxDispatchBlockedNow();');
    expect(source).toContain('sessionRefsAtSend.length > 0 || uploadsInFlight > 0');
    expect(source).toContain('|| outboxPumpBusyRef.current || dispatchBlockedAtSend');
    // dialogue 会话的 workingDir 由被控端在创建时分配,合成行此刻为空 —— 校验推迟到
    // dispatch(那时会重读 store 拿权威值),否则新建对话发消息会被误判成缺工作目录。
    expect(source).toContain('if (!dispatchBlockedAtSend && !currentSession.workingDir) {');
  });

  it('keeps legacy Plan out of deferred delivery without affecting the modern Plan path', () => {
    const source = readSource(SCREEN);
    const guardStart = source.indexOf('const legacyPlanRequiresLiveDispatch =');
    const optimisticClearStart = source.indexOf('if (text) applyComposerDocument(documentAfterOptimisticClear);');
    const outboxStart = source.indexOf('if (useLocalOutbox) {', guardStart);
    const guard = source.slice(guardStart, outboxStart);

    expect(guardStart).toBeGreaterThan(-1);
    expect(guardStart).toBeLessThan(optimisticClearStart);
    expect(guard).toContain("runtimeOptions?.planModeSupported !== true");
    expect(guard).toContain('const useLocalOutbox = shouldUseLocalOutbox && !legacyPlanRequiresLiveDispatch;');
    expect(guard).toContain('dispatchBlockedAtSend || outboxRef.current.length > 0 || outboxPumpBusyRef.current');
    expect(guard).not.toContain("setError(t('session.menu.aiRenameOffline'));");
    expect(source).toContain(
      'const recovery = recoverOutboxItemsToComposerDraft([capturedDraftRecoveryItem()], {',
    );
    expect(source).toContain('applyComposerDocument(recovery.document);');
    expect((source.match(/restoreDirectSendDraftAfterFailure\(\)/g) ?? [])).toHaveLength(4);
    expect(source).not.toContain('shouldWaitForOutboxEnqueueRecovery');
    expect(source).toContain('maker.setPlanMode(sessionId, next)');
    expect(source).not.toContain('restoreOnly');
    expect(source).not.toContain('legacyPlanRecovery');
    expect(source).not.toContain('legacyPlanRestore');
  });

  it('preserves a new-session legacy Plan draft until live dispatch is available', () => {
    const source = readSource('app/sessions/new.tsx');

    expect(source).toContain('!planModeCapability');
    expect(source).toContain("draft.permissionMode === 'plan'");
    expect(source).toContain("deviceLinkStatus !== 'online'");
    expect(source).toContain('getPresenceAvailability(selectedDeviceId) === false');
    expect(source).toContain("setError(t('session.menu.aiRenameOffline'));");
  });

  it('keeps the page outbox on the pre-write side of the enqueue ownership boundary', () => {
    const source = readSource(SCREEN);
    const outboxStart = source.indexOf('const dispatchOutboxItem = async (item: MobileOutboxItem) => {');
    const directStart = source.indexOf('const queuedDraft = buildQueuedTextMessage(');
    const directEnd = source.indexOf('// applied:消息已在桌面队列', directStart);
    const outboxDispatch = source.slice(outboxStart, directStart);
    const directRecovery = source.slice(directStart, directEnd);
    const unknownStart = outboxDispatch.indexOf('if (acceptanceUnknown) {');
    const unknownEnd = outboxDispatch.indexOf('const applied = await', unknownStart);
    const acceptanceUnknownRecovery = outboxDispatch.slice(unknownStart, unknownEnd);

    expect(source).toContain('const waitForConnection = (');
    expect(source).toContain('const waiting = outboxItemWaitingForConnection(item);');
    expect(source).toContain("if (result === 'deferred' || result === 'stopped') return;");
    expect(source).toContain("return 'stopped' as const;");
    expect(source).toContain('const safeToRetry = isSafelyUnsentOutboxEnqueueError(err);');
    expect(source).toContain(
      'const acceptanceUnknown = !safeToRetry && isAutoRecoveringRemoteError(err);',
    );
    expect(source).toContain('if (safeToRetry) {\n          waitForConnection(err);');
    // 回执不确定时只保留原 optimistic projection，不能把已开始写的消息重新交给
    // page-local outbox / 草稿；后者离场时没有跨页 clientId owner。
    expect(acceptanceUnknownRecovery).toContain('fresh.pendingQueue.some(');
    expect(acceptanceUnknownRecovery).toContain('setError(formatRemoteError(err));');
    expect(acceptanceUnknownRecovery).not.toContain('failItem(');
    expect(acceptanceUnknownRecovery).not.toContain('waitForConnection(');
    expect(acceptanceUnknownRecovery).not.toContain('salvageOutboxItem(');
    expect(outboxDispatch).toContain('return fresh.pendingQueue.some(');
    expect(source).not.toContain('shouldWaitForOutboxEnqueueRecovery');
    expect(source).toContain('isAutoRecoveringSessionReferencePreparationError(err)');
    expect(directRecovery).not.toContain('buildOutboxItem({');
    expect(directRecovery).not.toContain('salvageOutboxItem(');
    expect(directRecovery).not.toContain('updateOutbox(');
    expect(directRecovery).toContain('在线直发一旦开始 enqueue 就不再转入本 PR 的页面 outbox');
  });

  it('keeps retrying authoritative recovery syncs with bounded backoff', () => {
    const source = readSource(SCREEN);
    const retryStart = source.indexOf('const shouldAutoRetryConnectionSync =');
    const retryEnd = source.indexOf('\n\n  // 监听 error-persisted', retryStart);
    const retry = source.slice(retryStart, retryEnd);
    const syncCatchStart = source.indexOf('    } catch (err) {', source.indexOf('const syncSession ='));
    const syncCatchEnd = source.indexOf('    } finally {', syncCatchStart);
    const syncCatch = source.slice(syncCatchStart, syncCatchEnd);

    expect(source).toContain("useRef<{ identity: string; attempt: number } | null>(null)");
    expect(retry).toContain('isAutoRecoveringRemoteError(connectionRecoveryError)');
    expect(retry).toContain('const retryIdentity = `${deviceId}:${sessionId}:${connectionEpoch}`;');
    expect(retry).not.toContain('${connectionRecoveryError}');
    expect(retry).toContain('attempt: retryState.attempt + 1,');
    expect(retry).toContain('connectionRecoverySyncRetryDelayMs(retryState.attempt)');
    expect(retry).toContain('return () => clearTimeout(timer);');
    expect(retry).toContain('targetAvailableForDispatch === false');
    expect(retry).toContain('|| isDeviceUnresponsive');
    expect(syncCatch).toContain('latchOutboxTransportHold(formatted);');
    expect(syncCatch).not.toContain('? null : current');
    expect(source).toContain('error={connectionRecoveryError}');
  });

  it('fences every pre-outbox await against an in-place session switch', () => {
    const source = readSource(SCREEN);

    expect(source).toContain('const recoverCapturedDraftForScopeExit = () => {');
    expect(source).toContain('restoreRecoverableItemsToDraft(sessionId, [capturedDraftRecoveryItem()]);');
    expect(source).toContain('const hydratedDocumentAtSend = await hydrateComposerMessageReferenceBodies(');
    expect(source).toContain('if (!sendScopeStillAlive()) {\n      recoverCapturedDraftForScopeExit();');
    expect(source).toContain('await waitForPastePlaceholdersSettled();\n          if (!sendScopeStillAlive()) {');
    expect(source).toContain('const { failedCount } = await waitForPendingUploads();\n      if (!sendScopeStillAlive()) {');
    expect(source).toContain('if (outboxSessionAliveRef.current !== item.sessionId) return \'stopped\' as const;');
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
    const fnEnd = screen.indexOf('\n\n  // Context 面板', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = screen.slice(fnStart, fnEnd);
    expect(fn).toContain('if (!canUseRemoteSessionControls) return false;');
    // 锁进依赖,回调不会停留在「未锁」那一帧。
    expect(fn).toContain('outboxConnectionDispatchBlocked,');
    expect(fn).toContain('canUseRemoteSessionControls,');
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
    expect(source).toContain('disabled={controlBusy || !canUseRemoteSessionControls}');
    // 2) 会话设置 RPC 的硬门(统一入口,覆盖全部 runControlAction 调用点)。
    expect(source).toContain('if (!canUseRemoteSessionControls) return;\n    setControlBusy(true);');
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
