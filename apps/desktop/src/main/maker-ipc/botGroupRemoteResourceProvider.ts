/**
 * Bot group chat for controllers (phones) through the Remote Resource protocol
 * (docs/product-rules/bot-group-chat.md §8, docs/dev-rules/remote-and-mobile-adaptation.md).
 *
 * The host keeps every rule: this module only projects groups and forwards actions to
 * the same group service the local window uses. Host paths never leave the computer, and a
 * group is shown only while every member is a remotely visible teammate.
 */

import path from 'node:path';

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
  type BotGroupDetail,
  type BotGroupFailure,
  type BotGroupRemoteActionId,
  type BotGroupRemoteChatData,
  type BotGroupSummary,
} from '../../shared/botGroupChat.js';
import type { BotGroupChatService } from './botGroupChatService.js';

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
      subtitle: group.members.map((member) => member.name).join('、'),
      ...(preview ? { preview } : {}),
      timestamp: group.lastMessage?.createdAt ?? group.updatedAt,
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

/** Host paths stay on the computer; the phone gets the folder name and attachment names only. */
export function botGroupRemoteChatData(detail: BotGroupDetail): BotGroupRemoteChatData {
  return {
    ...detail,
    projectDir: null,
    projectDirName: detail.projectDir ? path.basename(detail.projectDir) : null,
    plans: detail.plans.map((plan) => ({ ...plan, workDir: null })),
    messages: detail.messages.map((message) => (message.attachments.length > 0
      ? { ...message, attachments: message.attachments.map((attachment) => ({ ...attachment, path: null })) }
      : message)),
    supportsAttachments: true,
  };
}

function fallbackMarkdown(detail: BotGroupDetail): string {
  const lines = detail.messages
    .filter((message) => message.kind === 'message' && (message.content.trim() || message.attachments.length > 0))
    .slice(-FALLBACK_MESSAGES)
    .map((message) => {
      // Older phones cannot show attachments; they still see what was attached.
      const attached = message.attachments.map((attachment) => `📎 ${attachment.name}`).join(' ');
      const text = [message.content.replace(/\s+/g, ' ').trim(), attached].filter(Boolean).join(' ');
      const clipped = Array.from(text).length > FALLBACK_MESSAGE_CHARS
        ? `${Array.from(text).slice(0, FALLBACK_MESSAGE_CHARS - 1).join('')}…`
        : text;
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

/** A group reaches a phone only while every member is a remotely visible teammate. */
async function visibleGroups<T extends Pick<BotGroupSummary, 'members'>>(groups: readonly T[]): Promise<T[]> {
  const visibility = await remoteVisibility(groups.flatMap((group) => group.members.map((member) => member.botId)));
  return groups.filter((group) => group.members.every((member) => visibility.get(member.botId) === true));
}

/** The same rule for anything else that reaches a phone about a group, such as a step push. */
export async function botGroupMembersVisibleRemotely(memberBotIds: readonly string[]): Promise<boolean> {
  const visibility = await remoteVisibility(memberBotIds);
  return memberBotIds.every((botId) => visibility.get(botId) === true);
}

async function assertBotsVisible(botIds: readonly string[]): Promise<void> {
  const visibility = await remoteVisibility(botIds);
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
      const groups = await visibleGroups(result.groups);
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
        await assertBotsVisible(botIds);
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
      // Every action re-checks that the phone may still see this group, and any teammate it names.
      await readVisibleGroup(groupId);
      if (actionId === 'update' && typeof input.organizerBotId === 'string') await assertBotsVisible([input.organizerBotId]);
      if (actionId === 'set-members') await assertBotsVisible(botIdsInput());
      if (actionId === 'plan-edit' && typeof input.botId === 'string') await assertBotsVisible([input.botId]);
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
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          }, { controllerDeviceId: context.controllerDeviceId });
          break;
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
          result = await current.updateGroup(patch);
          break;
        }
        case 'set-members':
          result = await current.setMembers({ groupId, botIds: botIdsInput() });
          break;
        case 'delete':
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
