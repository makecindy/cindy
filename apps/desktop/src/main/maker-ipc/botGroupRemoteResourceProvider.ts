import { teammateGroupActivity } from '@cindy/maker-shared/teammate-status';
/**
 * Bot group chat for controllers (phones) through the Remote Resource protocol
 * (docs/product-rules/bot-group-chat.md §8, docs/dev-rules/remote-and-mobile-adaptation.md).
 *
 * The host keeps every rule: this module only projects groups and forwards actions to
 * the same group service the local window uses. Host paths never leave the computer, and a
 * group is shown only while every member is a remotely visible teammate.
 */

import path from 'node:path';
import { chatGroupFailure } from './chatServerErrors.js';

import { inArray } from 'drizzle-orm';
import type {
  RemoteActionInvokeResponse,
  RemoteCollectionItem,
  RemoteLocalizedText,
  RemoteResource,
  RemoteResourceRef,
} from '@cindy/device-link';

import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import {
  RemoteResourceRegistryError,
  remoteResourceRegistry,
} from '../device-link/remoteResourceRegistry.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
} from '../localDb/ipc/botRemoteResourceProjection.js';
import { isBotVisibleRemotely } from '../localDb/ipc/botRemoteVisibility.js';
import { botProfiles } from '../localDb/schema.js';
import {
  BOT_GROUP_CHAT_PRIMITIVE,
  BOT_GROUP_MEMBER_LINK_REL,
  BOT_GROUP_REMOTE_COLLECTION_ID,
  BOT_GROUP_REMOTE_RESOURCE_KIND,
  type ChatMaskAction,
  type BotGroupDetail,
  type BotGroupFailure,
  type BotGroupMessageView,
  type BotGroupRemoteActionId,
  type BotGroupRemoteChatData,
  type BotGroupSummary,
  type BotGroupThreadShareView,
} from '../../shared/botGroupChat.js';
import type { BotGroupChatService } from './botGroupChatService.js';
import { botGroupActivityAt, projectBotGroupExecutionFailures } from '@cindy/maker-shared/botGroupPresentation';

const FALLBACK_MESSAGES = 20;
const FALLBACK_MESSAGE_CHARS = 280;

type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko';
type Copy = Record<Locale, string>;

const COPY = {
  title: { en: 'Group chats', 'zh-CN': '群聊', 'zh-TW': '群聊', ja: 'グループチャット', ko: '그룹 채팅' },
  planning: {
    en: '{name} is splitting the work…',
    'zh-CN': '{name}正在安排…',
    'zh-TW': '{name}正在安排…',
    ja: '{name} が役割分担を考えています…',
    ko: '{name} 님이 역할을 나누는 중…',
  },
  proposed: {
    en: '{name}: plan ready, waiting for you',
    'zh-CN': '{name}：安排好了，等你开始',
    'zh-TW': '{name}：安排好了，等你開始',
    ja: '{name}：分担が決まりました。開始を待っています',
    ko: '{name}: 분담을 정했어요. 시작을 기다려요',
  },
  running: {
    en: 'Step {step}/{total} · {name} is working',
    'zh-CN': '分工 {step}/{total} · {name}正在做',
    'zh-TW': '分工 {step}/{total} · {name}正在做',
    ja: '分担 {step}/{total} · {name} が作業中',
    ko: '분담 {step}/{total} · {name} 작업 중',
  },
  stepDone: {
    en: '{name} is done — continue when ready',
    'zh-CN': '{name}做完了，等你继续',
    'zh-TW': '{name}做完了，等你繼續',
    ja: '{name} が完了しました。続行を待っています',
    ko: '{name} 님이 끝냈어요. 계속을 기다려요',
  },
  stepFailed: {
    en: "{name} didn't finish",
    'zh-CN': '{name}没做完',
    'zh-TW': '{name}沒做完',
    ja: '{name} は完了できませんでした',
    ko: '{name} 님이 끝내지 못했어요',
  },
  lastMessage: {
    en: '{name}: {text}',
    'zh-CN': '{name}：{text}',
    'zh-TW': '{name}：{text}',
    ja: '{name}：{text}',
    ko: '{name}: {text}',
  },
  memberJoined: {
    en: '{name} joined the group',
    'zh-CN': '{name}加入了群聊',
    'zh-TW': '{name}加入了群聊',
    ja: '{name}さんがグループに参加しました',
    ko: '{name} 님이 그룹에 참여했습니다',
  },
  sharedReplyYou: {
    en: 'You shared a thread reply',
    'zh-CN': '你贴回了一条话题回复',
    'zh-TW': '你貼回了一則話題回覆',
    ja: 'スレッドの返信を共有しました',
    ko: '스레드 답글을 공유했습니다',
  },
  sharedReply: {
    en: '{name} shared a thread reply',
    'zh-CN': '{name} 贴回了一条话题回复',
    'zh-TW': '{name} 貼回了一則話題回覆',
    ja: '{name} がスレッドの返信を共有しました',
    ko: '{name} 님이 스레드 답글을 공유했습니다',
  },
} satisfies Record<string, Copy>;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function localized(copy: Copy, vars: Record<string, string | number> = {}): RemoteLocalizedText {
  const { en, ...rest } = copy;
  return {
    fallback: fill(en, vars),
    translations: Object.fromEntries(Object.entries(rest).map(([locale, text]) => [locale, fill(text, vars)])),
  };
}

function groupRef(groupId: string): RemoteResourceRef {
  return { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: groupId };
}

/** Sidebar line for a group, the same states the desktop sidebar shows. */
export function botGroupRemotePreview(group: BotGroupSummary): RemoteLocalizedText | string | undefined {
  const name = (botId: string | null) => group.members.find((member) => member.botId === botId)?.name ?? '';
  if (group.planningBotId) return localized(COPY.planning, { name: name(group.planningBotId) });
  const plan = group.openPlan;
  if (plan?.status === 'proposed') return localized(COPY.proposed, { name: name(group.organizerBotId) });
  if (plan?.status === 'running' && plan.currentStep !== null) {
    return localized(COPY.running, { step: plan.currentStep + 1, total: plan.stepCount, name: plan.currentBotName ?? '' });
  }
  if (plan?.status === 'waiting' && plan.currentBotName) {
    return localized(plan.currentStepStatus === 'failed' ? COPY.stepFailed : COPY.stepDone, { name: plan.currentBotName });
  }
  const last = group.lastMessage;
  if (!last) return undefined;
  if (last.authorKind === 'system' && last.noticeCode === 'member-joined')
    return localized(COPY.memberJoined, { name: last.authorName });
  // A share names who posted it; the card's own text is never quoted here.
  if (last.threadShare) {
    return last.authorKind === 'user' && last.isSelf !== false
      ? localized(COPY.sharedReplyYou) : localized(COPY.sharedReply, { name: last.authorName.trim() });
  }
  return last.authorKind === 'bot' && last.authorName
    ? localized(COPY.lastMessage, { name: last.authorName, text: last.preview })
    : last.preview;
}

export function botGroupRemoteItem(group: BotGroupSummary): RemoteCollectionItem {
  const busy = group.speakingBotIds.length > 0 || group.planningBotId !== null;
  const preview = botGroupRemotePreview(group);
  return {
    ref: groupRef(group.id),
    display: {
      title: group.name,
      teammateActivity: teammateGroupActivity(group),
      subtitle: group.members.map((member) => member.name).join('、'),
      ...(preview ? { preview } : {}),
      timestamp: botGroupActivityAt(group),
      lastReplyAt: group.lastReplyAt,
      ...(busy ? { generation: { phase: 'processing', startedAt: null } } : {}),
    },
    links: group.members.map((member) => ({
      rel: BOT_GROUP_MEMBER_LINK_REL,
      target: {
        kind: 'resource' as const,
        ref: { collectionId: TEAMMATES_REMOTE_COLLECTION_ID, kind: BOT_REMOTE_RESOURCE_KIND, id: member.botId },
      },
      label: member.name,
    })),
    revision: JSON.stringify([
      teammateGroupActivity(group).phase,
      group.updatedAt,
      group.name,
      group.members.map((member) => [member.botId, member.name, member.status]),
      group.organizerBotId,
      group.lastMessage?.createdAt ?? null,
      group.openPlan,
      group.speakingBotIds,
      group.planningBotId,
    ]),
  };
}

function withoutPaths(attachments: BotGroupMessageView['attachments']): BotGroupMessageView['attachments'] {
  return attachments.map((attachment) => ({ ...attachment, path: null }));
}

/** A shared reply carries its own attachments, downloaded to this computer. */
function shareWithoutPaths(share: BotGroupThreadShareView): BotGroupThreadShareView {
  return share.attachments.length > 0 ? { ...share, attachments: withoutPaths(share.attachments) } : share;
}

/** Host paths stay on the computer; the phone gets the folder name and attachment names only. */
export function botGroupRemoteChatData(detail: BotGroupDetail): BotGroupRemoteChatData {
  return {
    ...detail,
    projectDir: null,
    projectDirName: detail.projectDir ? path.basename(detail.projectDir) : null,
    plans: detail.plans.map((plan) => ({ ...plan, workDir: null })),
    // Older phones consume message views only; derive from this read's state here.
    messages: projectBotGroupExecutionFailures(detail.messages, detail.executionFailures).map((message) => {
      const view = message.attachments.length > 0 ? { ...message, attachments: withoutPaths(message.attachments) } : message;
      return view.threadShare ? { ...view, threadShare: shareWithoutPaths(view.threadShare) } : view;
    }),
    ...(detail.threadShareUpdates ? { threadShareUpdates: Object.fromEntries(Object.entries(detail.threadShareUpdates)
      .map(([id, share]) => [id, shareWithoutPaths(share)])) } : {}),
    supportsAttachments: true,
    supportsReadReceipts: detail.serverBacked === true,
    supportsPersonalMask: detail.serverBacked === true,
    supportsMemberRemoval: detail.serverBacked === true,
    supportsSettingsManagement: detail.serverBacked === true,
  };
}

function fallbackMarkdown(detail: BotGroupDetail): string {
  const lines = detail.messages
    .filter((message) => (message.kind === 'message' || (message.kind === 'notice' && message.authorKind === 'system' &&
      (message.noticeCode === 'member-joined' || message.noticeCode === null))) &&
      (message.content.trim() || message.attachments.length > 0))
    .slice(-FALLBACK_MESSAGES)
    .map((message) => {
      // Older phones cannot show attachments; they still see what was attached.
      const attached = message.attachments.map((attachment) => `📎 ${attachment.name}`).join(' ');
      const text = [message.content.replace(/\s+/g, ' ').trim(), attached].filter(Boolean).join(' ');
      const clipped = Array.from(text).length > FALLBACK_MESSAGE_CHARS
        ? `${Array.from(text).slice(0, FALLBACK_MESSAGE_CHARS - 1).join('')}…`
        : text;
      if (message.authorKind === 'system') return clipped;
      return message.authorKind === 'user' ? `> ${clipped}` : `**${message.authorName}**: ${clipped}`;
    });
  return lines.length > 0 ? lines.join('\n\n') : detail.name;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A refused action reports the group's own error code so controllers can word it. */
function refuse(result: BotGroupFailure): never {
  throw new RemoteResourceRegistryError(result.errorCode === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_PARAMS', result.errorCode);
}

async function remoteVisibility(botIds: readonly string[]): Promise<Map<string, boolean>> {
  if (botIds.length === 0) return new Map();
  const rows = await getDbClient()
    .drizzle.select({ id: botProfiles.id, hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
    .from(botProfiles)
    .where(inArray(botProfiles.id, [...new Set(botIds)]));
  return new Map(rows.map((row) => [row.id, isBotVisibleRemotely(row)]));
}

/** Server membership authorizes human/foreign members; local Bot hiding still applies. */
async function visibleGroups<T extends Pick<BotGroupSummary, 'members' | 'serverBacked'>>(groups: readonly T[]): Promise<T[]> {
  const localMembers = (group: T) => group.members.filter(member => !group.serverBacked || (member.actorKind === 'bot' && member.isOwned));
  const visibility = await remoteVisibility(groups.flatMap(group => localMembers(group).map(member => member.botId)));
  return groups.filter(group => localMembers(group).every(member => (group.serverBacked && !visibility.has(member.botId)) || visibility.get(member.botId) === true));
}

/** The same rule for anything else that reaches a phone about a group, such as a step push. */
export async function botGroupMembersVisibleRemotely(memberBotIds: readonly string[]): Promise<boolean> {
  const visibility = await remoteVisibility(memberBotIds);
  return memberBotIds.every((botId) => visibility.get(botId) === true);
}

async function assertBotsVisible(botIds: readonly string[], server?: BotGroupChatService['chatServer']): Promise<void> {
  const visibility = await remoteVisibility(botIds);
  // Only absent local rows can be resolved account-wide. A hidden local row is
  // never made remotely visible by also appearing in the cloud directory.
  const missing = botIds.filter(botId => !visibility.has(botId));
  if (missing.length && server) {
    const owned = await server.ownedBots();
    if (owned.ok) for (const bot of owned.bots) {
      if (bot.botId && missing.includes(bot.botId)) visibility.set(bot.botId, true);
    }
  }
  if (botIds.some((botId) => visibility.get(botId) !== true)) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'MEMBER_UNAVAILABLE');
  }
}

let registered = false;

export function registerBotGroupRemoteResourceProvider(service: () => BotGroupChatService | null): void {
  if (registered) return;
  registered = true;

  const requireService = (): BotGroupChatService => {
    const current = service();
    if (!current) throw new RemoteResourceRegistryError('NOT_FOUND', 'HOST_NOT_READY');
    return current;
  };

  /** The group, if a phone may see it right now. */
  const readVisibleGroup = async (groupId: string): Promise<BotGroupDetail> => {
    const result = await requireService().getGroup(groupId);
    if (!result.ok) refuse(result);
    const [visible] = await visibleGroups([result.group]);
    if (!visible) throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
    return visible;
  };

  remoteResourceRegistry.register({
    collection: {
      id: BOT_GROUP_REMOTE_COLLECTION_ID,
      resourceKind: BOT_GROUP_REMOTE_RESOURCE_KIND,
      title: localized(COPY.title),
      icon: { name: 'users', fallbackText: '••' },
      actions: [{ id: 'create' satisfies BotGroupRemoteActionId, label: localized(COPY.title) }],
    },

    async list(_context, request) {
      const scope = captureDataOwnerBroadcastScope();
      const result = await requireService().listGroups();
      if (!result.ok) refuse(result);
      const groups = await visibleGroups(result.groups.filter(group => !group.archived));
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const query = request.query?.trim().toLocaleLowerCase() ?? '';
      const matched = query
        ? groups.filter((group) =>
          [group.name, ...group.members.map((member) => member.name)].some((value) => value.toLocaleLowerCase().includes(query)))
        : groups;
      const items = matched.slice(0, request.limit ?? 200).map(botGroupRemoteItem);
      return {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
      };
    },

    async get(_context, request) {
      const scope = captureDataOwnerBroadcastScope();
      const detail = await readVisibleGroup(request.ref.id);
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const resource: RemoteResource = {
        ...botGroupRemoteItem(detail),
        blocks: [
          request.client.primitives.includes(BOT_GROUP_CHAT_PRIMITIVE)
            ? {
              id: 'chat',
              primitive: BOT_GROUP_CHAT_PRIMITIVE,
              fallbackMarkdown: fallbackMarkdown(detail),
              data: botGroupRemoteChatData(detail),
            }
            // Older controllers can still read the conversation.
            : { id: 'chat', primitive: 'markdown', fallbackMarkdown: fallbackMarkdown(detail) },
        ],
      };
      return resource;
    },

    async invoke(context, request): Promise<RemoteActionInvokeResponse> {
      // Checks read the current account's data; a switch before the write must not let them
      // authorize a change to the next account.
      const scope = captureDataOwnerBroadcastScope();
      const ownerService = (): BotGroupChatService => {
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        return requireService();
      };
      const actionId = request.actionId as BotGroupRemoteActionId;
      const input = recordOf(request.input);
      const botIdsInput = (): string[] =>
        Array.isArray(input.botIds) ? input.botIds.filter((id): id is string => typeof id === 'string') : [];

      if (actionId === 'create') {
        const botIds = botIdsInput();
        await assertBotsVisible(botIds, ownerService().chatServer);
        const created = await ownerService().createGroup({ name: input.name, botIds });
        if (!created.ok) refuse(created);
        return {
          effects: [
            { kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID },
            { kind: 'navigate', target: { kind: 'resource', ref: groupRef(created.groupId) } },
          ],
        };
      }

      const groupId = request.resourceRef?.collectionId === BOT_GROUP_REMOTE_COLLECTION_ID
        ? request.resourceRef.id
        : null;
      if (!groupId) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'INVALID_PARAMS');
      // Personal state is authorized by the account's historical membership, even after leave.
      if (actionId === 'hide') {
        const server = ownerService().chatServer;
        if (!server) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'LIFECYCLE_UNAVAILABLE');
        const hidden = await server.manage({ groupId, action: { type: 'hide' } });
        if (!hidden.ok) refuse(chatGroupFailure(new Error(hidden.errorCode)));
        return { result: { listState: hidden.listState }, effects: [{ kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID }] };
      }
      // Every action re-checks that the phone may still see this group, and any teammate it names.
      const visibleGroup = await readVisibleGroup(groupId);
      // New controllers bind a write to the snapshot they edited. Older controllers
      // retain their existing actions; the server remains the final permission owner.
      if (visibleGroup.serverBacked && input.expectedRevision !== undefined) {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== visibleGroup.revision)
          throw new RemoteResourceRegistryError('INVALID_PARAMS', 'PRECONDITION_FAILED');
      }
      if (actionId === 'add-member') {
        if (!visibleGroup.serverBacked || typeof input.botId !== 'string')
          throw new RemoteResourceRegistryError('INVALID_PARAMS', 'INVALID_PARAMS');
        await assertBotsVisible([input.botId], ownerService().chatServer);
      }
      const candidateId = actionId === 'update' ? input.organizerBotId : actionId === 'plan-edit' ? input.botId : undefined;
      if (typeof candidateId === 'string') {
        const member = visibleGroup.members.find(member => member.botId === candidateId);
        if (visibleGroup.serverBacked) {
          if (!member || member.actorKind !== 'bot' || member.status !== 'active')
            throw new RemoteResourceRegistryError('INVALID_PARAMS', 'MEMBER_UNAVAILABLE');
        } else await assertBotsVisible([candidateId]);
      }
      if (actionId === 'set-members') {
        // Preserve existing server members; additions must be visible local or owned cloud companions.
        const currentMemberIds = new Set(visibleGroup.members.map(member => member.botId));
        await assertBotsVisible(botIdsInput().filter(botId => !currentMemberIds.has(botId)), visibleGroup.serverBacked ? ownerService().chatServer : undefined);
      }
      const current = ownerService();
      const planInput = { groupId, planId: input.planId };
      let result: { ok: true } | BotGroupFailure;
      switch (actionId) {
        case 'send':
          result = await current.sendMessage({
            groupId,
            text: input.text,
            mentions: input.mentions,
            clientId: input.clientId,
            division: input.division === true,
            ...(input.quote !== undefined ? { quote: input.quote } : {}),
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          }, { controllerDeviceId: context.controllerDeviceId });
          break;
        case 'mask':
        case 'mask-mentions': {
          if (!visibleGroup.serverBacked || !current.chatServer?.mask || !current.chatServer.mentions)
            throw new RemoteResourceRegistryError('INVALID_PARAMS', 'UNSUPPORTED_OPERATION');
          // The ordinary account-scoped API validates the complete input and keeps
          // the mask owner separate from the group's administrator.
          const receipt = actionId === 'mask'
            ? await current.chatServer.mask({ groupId, action: input.action as ChatMaskAction | undefined, operationId: input.operationId as string | undefined })
            : await current.chatServer.mentions({ groupId, before: input.before as string | undefined,
              readIds: input.readIds as string[] | undefined, operationId: input.operationId as string | undefined });
          if (!receipt.ok) throw new RemoteResourceRegistryError('INVALID_PARAMS', receipt.errorCode);
          ownerService();
          return { result: receipt, effects: [] };
        }
        case 'read': {
          if (!visibleGroup.serverBacked || !current.chatServer || typeof input.messageId !== 'string')
            throw new RemoteResourceRegistryError('INVALID_PARAMS', 'INVALID_PARAMS');
          const receipt = await current.chatServer.manage({ groupId, action: { type: 'read', messageId: input.messageId } });
          if (!receipt.ok) refuse(chatGroupFailure(new Error(receipt.errorCode)));
          return { effects: [] };
        }
        case 'continue':
          result = await current.continueRound(groupId);
          break;
        case 'stop':
          result = await current.stopRound(groupId);
          break;
        case 'update': {
          // A phone cannot point the group at a folder on this computer.
          const patch: Record<string, unknown> = { groupId };
          for (const key of ['name', 'replyMode', 'speakingMode', 'organizerBotId'] as const) {
            if (input[key] !== undefined) patch[key] = input[key];
          }
          if (input.expectedRevision !== undefined) patch.expectedRevision = input.expectedRevision;
          result = await current.updateGroup(patch);
          break;
        }
        case 'remove-member': {
          const member = visibleGroup.members.find(member => member.actorId === input.actorId);
          if (!visibleGroup.serverBacked || !current.chatServer || !member?.actorId)
            throw new RemoteResourceRegistryError('INVALID_PARAMS', 'NOT_FOUND');
          const removed = await current.chatServer.manage({ groupId, action: { type: 'member', action: 'remove', actorId: member.actorId } });
          if (!removed.ok) refuse(chatGroupFailure(new Error(removed.errorCode)));
          result = { ok: true };
          break;
        }
        case 'set-members':
          result = await current.setMembers({ groupId, botIds: botIdsInput() });
          break;
        case 'add-member':
          result = await current.setMembers({ groupId, botIds: [input.botId as string], addOnly: true });
          break;
        case 'dissolve':
        case 'leave': {
          if (!visibleGroup.serverBacked || !current.chatServer)
            throw new RemoteResourceRegistryError('INVALID_PARAMS', 'LIFECYCLE_UNAVAILABLE');
          const self = visibleGroup.members.find(member => member.isSelf);
          if (actionId === 'leave' && !self?.actorId) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'NOT_FOUND');
          const receipt = await current.chatServer.manage({ groupId, action: actionId === 'dissolve'
            ? { type: 'dissolve', expectedRevision: input.expectedRevision as number }
            : { type: 'member', action: 'leave', actorId: self!.actorId! } });
          if (!receipt.ok) refuse(chatGroupFailure(new Error(receipt.errorCode)));
          return { effects: [{ kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID }] };
        }
        case 'delete':
          if (visibleGroup.serverBacked && input.expectedRevision !== undefined) {
            if (!current.chatServer || !visibleGroup.members.some(member => member.isOwned && member.role === 'owner'))
              throw new RemoteResourceRegistryError('INVALID_PARAMS', 'PERMISSION_DENIED');
            const archived = await current.chatServer.manage({ groupId, action: { type: 'archive', archived: true, expectedRevision: visibleGroup.revision! } });
            if (!archived.ok) refuse(chatGroupFailure(new Error(archived.errorCode)));
            return { effects: [{ kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID }] };
          }
          result = await current.deleteGroup(groupId);
          if (!result.ok) refuse(result);
          return { effects: [{ kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID }] };
        case 'plan-start':
          result = await current.startPlan(planInput);
          break;
        case 'plan-dismiss':
          result = await current.dismissPlan(planInput);
          break;
        case 'plan-continue':
          result = await current.continuePlan(planInput);
          break;
        case 'plan-retry':
          result = await current.retryPlan(planInput);
          break;
        case 'plan-edit':
          result = await current.editPlanStep({ ...planInput, position: input.position, action: input.action, botId: input.botId });
          break;
        default:
          throw new RemoteResourceRegistryError('INVALID_PARAMS', 'INVALID_PARAMS');
      }
      if (!result.ok) refuse(result);
      return { effects: [{ kind: 'refresh-resource', ref: groupRef(groupId) }] };
    },
  });
}
