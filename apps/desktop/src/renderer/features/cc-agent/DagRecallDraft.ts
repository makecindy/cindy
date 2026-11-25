import type { Session } from '@/lib/ccAgent.types';
import { dagQueueRecallContent } from '../../../shared/dagQueueRecall';
import { captureDraftDiscardToken, captureDraftRecoveryScope, clearDraft, draftHasContent, flushDraft, getDraft,
  isDraftDiscardTokenCurrent, saveDraft, type ComposerDraft } from '@/lib/composerDraftStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { splitGhostDirective } from '@/cindy-brain/ghostCommand';
import { splitHostCapabilityDirective } from '@/cindy-brain/hostCapabilityInvocation';
import { makerChatStore, type ChatMessage, type QueuedMessage } from '@/lib/makerChatStore';
import { queueMessageToComposerEditDraft, structuredQueueDocument } from '@/lib/queueComposerEdit';
import { buildRewindDraftAttachments } from '@/lib/rewindDraftAttachments';

type Target = Pick<Session, 'id' | 'source' | 'deviceLinkDeviceId' | 'remoteHostId' | 'userId'>;
type Result = { ok: false; reason: string } | { ok: true; attachments: number };
export type PreparedDagRecall = { ok: false; reason: string } | {
  ok: true; assertReady(): void; restore(): Result;
};
export const dagRecallRecoveryKey = (id: string) => `${id}:dag-recall`;
const fail = (reason: string) => ({ ok: false as const, reason });
function occupied(id: string) {
  flushDraft(id);
  const draft = getDraft(id);
  return Boolean(draftHasContent(draft) || draft?.builtInSkillIntent || draft?.pendingGhostId || draft?.botGroupEdit);
}
function checkOrigin(target: Target, msg: ChatMessage | undefined) {
  if (!target.id || target.remoteHostId || target.deviceLinkDeviceId || getSessionDeviceId(target.id) ||
      (target.source && target.source !== 'desktop' && target.source !== 'side-chat')) throw Error('此任务不支持本机撤回。');
  if (!msg || msg.role !== 'user' || msg.sourceDevice || msg.sourcePlugin || msg.automationOrigin || msg.sharedAuthorMemberId || msg.hookSource ||
      msg.systemCardType || msg.isSyntheticTrigger || msg.sourceGroup || msg.parentToolUseId || !makerChatStore.isLocalSentUserMessage(target.id, msg.clientId))
    throw Error('只能撤回可确认由本人输入的问题。');
}
function prepare(target: Target, msg: ChatMessage, draft: ComposerDraft, checkTurn?: () => void): PreparedDagRecall {
  const owner = getDataOwnerGeneration(), token = captureDraftDiscardToken(target.id);
  const key = dagRecallRecoveryKey(target.id), stash = captureDraftRecoveryScope(key);
  let done = false;
  const sameTarget = () => isDataOwnerGenerationCurrent(owner) && isDraftDiscardTokenCurrent(token) && !getSessionDeviceId(target.id);
  const assertReady = () => {
    if (done || !sameTarget()) throw Error('任务或账号已变化，未写入输入框。');
    checkTurn?.();
    if (occupied(key)) throw Error('请先取回上一次撤回的问题。');
    if (occupied(target.id)) throw Error('输入框已有草稿，先处理原草稿再撤回。');
  };
  try { checkOrigin(target, msg); assertReady(); } catch (e) { return fail((e as Error).message); }
  if (!draftHasContent(draft)) return fail('原问题没有可恢复的文字或附件。');
  return { ok: true, assertReady, restore() {
    if (done) return fail('本次问题已经取回。');
    done = true;
    if (!sameTarget() || occupied(target.id)) {
      // Keep a newer keystroke intact and keep the withdrawn input addressable.
      // The recovery slot is captured against the original account, not the active one.
      if (!draftHasContent(stash.get())) stash.save(draft);
      return fail('问题已撤回，未覆盖当前草稿。清空原任务输入框后可点「取回已撤回的问题」。');
    }
    saveDraft(target.id, draft);
    return { ok: true, attachments: draft.attachments.length };
  } };
}
/** Only call restore after the authoritative operation ID returns committed. */
export function prepareDagRecall(session: Target, message: ChatMessage | undefined): PreparedDagRecall {
  try { checkOrigin(session, message); } catch (e) { return fail((e as Error).message); }
  if (!message || message.isPendingPersist || message.blockedByGhost) return fail('问题尚未成为可核对的原生历史。');
  const content = (splitGhostDirective(message.content) ?? splitHostCapabilityDirective(message.content))?.body ?? message.content;
  const attachments = buildRewindDraftAttachments({ images: message.images, files: message.files });
  if (attachments.length !== (message.images?.length ?? 0) + (message.files?.length ?? 0)) return fail('部分原始附件无法恢复，未撤回问题。');
  return prepare(session, message, {
    text: structuredQueueDocument({ chatMessage: message }, content),
    attachments: attachments.map(file => ({ ...file, cacheUrlShared: true, stagedPathShared: true })), focusAtEnd: true,
  }, () => {
    const state = makerChatStore.getSnapshot(session.id);
    if (state.agentStatus.isRunning || state.isStreaming) throw Error('这一轮仍在运行。请先在原对话确认停止后再撤回；不会自动停止其他回合。');
  });
}
export function takeDagRecalledDraft(id: string): Result {
  const key = dagRecallRecoveryKey(id), draft = getDraft(key);
  if (!draft || !draftHasContent(draft)) return fail('没有待取回的问题。');
  if (occupied(id)) return fail('输入框已有内容，未覆盖。');
  saveDraft(id, draft);
  clearDraft(key);
  return { ok: true, attachments: draft.attachments.length };
}
const inFlight = new Set<string>();
export async function recallDagQueuedQuestion(session: Target, clicked: QueuedMessage, writable: () => boolean): Promise<Result> {
  const id = session.id, cid = clicked.clientId, scope = JSON.stringify([getDataOwnerGeneration(), id]);
  if (!writable() || !cid || inFlight.has(scope)) return fail('这一轮暂时不可撤回。');
  const state = makerChatStore.getSnapshot(id);
  const actual = state.pendingQueue.find(item => item.clientId === cid);
  if (actual !== clicked || actual.chatMessage.clientId !== cid || actual.isPendingEnqueue || actual.origin || actual.originalSyntheticTrigger ||
      actual.fromDeviceLinkClient || actual.sharedTaskAuthor || actual.sourcePlugin || actual.sourceDevice || actual.fromMobileClient ||
      state.steeringQueueClientIds.includes(cid) || state.queueEditLocks.includes(cid)) return fail('排队项已变化或不属于当前输入，未撤回。');
  const ticket = prepare(session, actual.chatMessage, queueMessageToComposerEditDraft(id, actual).draft);
  if (!ticket.ok) return ticket;
  const recall = window.electronAPI.maker.dagRecallQueued;
  if (!recall) return fail('当前宿主不能核对待发内容版本，未撤回。');
  inFlight.add(scope);
  try {
    const owner = getDataOwnerGeneration();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dagQueueRecallContent(actual)))), n => n.toString(16).padStart(2, '0')).join('');
    if (!writable() || !isDataOwnerGenerationCurrent(owner)) return fail('任务状态已变化，未撤回。');
    ticket.assertReady();
    const receipt = await recall(id, cid, digest, { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation });
    if (!receipt.ok) return fail(receipt.reason);
    if (receipt.sessionId !== id || receipt.clientId !== cid) return fail('未确认撤回结果；请核对原会话，不会自动重发。');
    return ticket.restore();
  } catch { return fail('未确认撤回结果；请核对原会话，不会自动重发。'); }
  finally { inFlight.delete(scope); }
}
