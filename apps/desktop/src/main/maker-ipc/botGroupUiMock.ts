/** Optional service input for the real, account-free Desktop --mock group route. */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import { teammateChatActivity } from '@cindy/maker-shared/teammate-status';
import { getActiveAppSession, LOCAL_DATA_OWNER_ID } from '../appSessionState.js';
import { isUiMockDataEnabled } from '../localDb/uiMockSeed.js';
import type { BotGroupDetail, BotGroupMessageView, ChatServerApi } from '../../shared/botGroupChat.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from './botGroupChatService.js';

const groupId = 'ui-mock-group-alert';
const planId = 'ui-mock-group-alert-plan';
const input = z.object({ status: z.enum(['waiting', 'stopped']), newFailure: z.boolean().default(false),
  pending: z.boolean().default(false), composer: z.boolean().default(false) });
type Input = z.infer<typeof input>;
const at = Date.parse('2026-10-03T00:00:00Z');

function read() {
  if (app.isPackaged || !isUiMockDataEnabled() || process.env.XDT_ISOLATED !== '1'
    || getActiveAppSession().dataOwnerId !== LOCAL_DATA_OWNER_ID) return undefined;
  const file = path.join(app.getPath('userData'), 'ui-mock', 'group-alert.json');
  try { return { file, data: input.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) }; } catch { return undefined; }
}

function detail(data: Input): BotGroupDetail {
  const steps = [{ position: 0, botId: 'ui-mock-member', botName: 'Nova', task: '整理检查结果', status: 'failed' as const },
    { position: 1, botId: 'ui-mock-member', botName: 'Nova', task: '复核结果', status: 'pending' as const }];
  const plans = [{ id: planId, status: data.status, organizerBotId: 'ui-mock-member', organizerName: 'Nova',
    steps, currentStep: 0, workDir: null, branch: null, kind: 'work' as const, canManage: true, canAdd: false,
    createdAt: at, updatedAt: at + 1000 }];
  const executions = [{ status: 'failed', plan_id: planId, updated_at: new Date(at + 1000).toISOString() },
    ...(data.newFailure ? [{ status: 'failed', updated_at: new Date(at + 2000).toISOString() }] : []),
    ...(data.pending ? [{ status: 'needs_input' }] : [])];
  return { id: groupId, name: '群告警验收', serverBacked: true, singleSpeaker: true,
    replyMode: 'all', speakingMode: 'auto', organizerBotId: 'ui-mock-member', projectDir: null,
    members: [{ botId: 'ui-mock-member', name: 'Nova', avatar: '🧭', avatarColor: 'violet', status: 'active' }],
    serverUnread: { count: 0, mentioned: false },
    teammateActivity: teammateChatActivity({ executions, plans, lastMessageAt: at }),
    lastMessage: { authorKind: 'bot', authorName: 'Nova', preview: '检查步骤失败，等待处理。', createdAt: at },
    lastReplyAt: at, speakingBotIds: [], planningBotId: null,
    openPlan: data.status === 'waiting' ? { id: planId, status: 'waiting', kind: 'work', currentStep: 0,
      stepCount: 2, currentBotName: 'Nova', currentStepStatus: 'failed' } : null,
    createdAt: at, updatedAt: at + 1000, round: { status: 'idle', speakers: [], canContinue: false, canStop: false },
    hasMoreBefore: false, plans,
    messages: [{ id: 'ui-mock-plan-card', sequence: 1, kind: 'plan', authorKind: 'bot',
      authorBotId: 'ui-mock-member', authorName: 'Nova', content: '检查步骤失败，等待处理。',
      mentions: { all: false, botIds: [] }, noticeCode: null, planId, files: [], attachments: [], createdAt: at }],
  };
}

/** Replaces only synthetic service inputs; routes, rendering and roster reduction stay real. */
export function withBotGroupUiMock(service: BotGroupChatService, deps: BotGroupChatServiceDeps): BotGroupChatService {
  const changed = () => deps.onChanged?.({ groupId, change: 'plan' }, deps.captureOwnerScope?.());
  // Synthetic transport state only; never runs a companion or contacts the server.
  const sent = new Map<string, BotGroupMessageView>();
  const project = (data: Input): BotGroupDetail => ({ ...detail(data), messages: [
    ...detail(data).messages, ...[...sent.values()].filter(message => !message.threadRootId),
  ] });
  const accept = (request: { clientId: string; text: string; rootId?: string }) => {
    const previous = sent.get(request.clientId);
    if (previous) return { ok: true as const, messageId: previous.id };
    const message: BotGroupMessageView = { id: request.clientId, sequence: sent.size + 2,
      kind: 'message', authorKind: 'user', authorBotId: null, authorName: 'UI tester', isSelf: true,
      content: request.text, mentions: { all: false, botIds: [] }, noticeCode: null, planId: null,
      files: [], attachments: [], createdAt: Date.now(), threadRootId: request.rootId ?? null };
    sent.set(request.clientId, message);
    if (request.rootId) {
      const root = [...sent.values()].find(value => value.id === request.rootId);
      if (root) root.replyCount = (root.replyCount ?? 0) + 1;
    }
    deps.onChanged?.({ groupId, change: 'messages' }, deps.captureOwnerScope?.());
    return { ok: true as const, messageId: message.id };
  };
  return {
    ...service,
    sendMessage: async (request, origin) => {
      const value = z.object({ groupId: z.literal(groupId), clientId: z.string().uuid(), text: z.string() }).safeParse(request);
      return value.success && read()?.data.composer ? accept(value.data) : service.sendMessage(request, origin);
    },
    get chatServer(): ChatServerApi | undefined {
      const chat = service.chatServer;
      return chat && { ...chat, manage: async request => {
        if (request.groupId === groupId && read() && request.action.type === 'read') return { ok: true as const };
        return chat.manage(request);
      }, thread: async request => {
        if (request.groupId !== groupId || !read()?.data.composer) return chat.thread(request);
        const root = [...sent.values()].find(message => message.id === request.rootId);
        if (!root) return { ok: false as const, errorCode: 'NOT_FOUND' as const, error: 'Synthetic root not found' };
        return { ok: true as const, root, replies: [...sent.values()].filter(message => message.threadRootId === root.id), hasMore: false };
      }, reply: async request => request.groupId === groupId && read()?.data.composer
        ? accept(request) : chat.reply(request) };
    },
    listGroups: async () => {
      const fixture = read();
      return fixture ? { ok: true, groups: [project(fixture.data)] } : service.listGroups();
    },
    getGroup: async (id, options) => {
      const fixture = id === groupId ? read() : undefined;
      return fixture ? { ok: true, group: project(fixture.data) } : service.getGroup(id, options);
    },
    dismissPlan: async request => {
      const fixture = read();
      if (!fixture || !request || typeof request !== 'object'
        || !('groupId' in request) || request.groupId !== groupId
        || !('planId' in request) || request.planId !== planId) return service.dismissPlan(request);
      fs.writeFileSync(fixture.file, JSON.stringify({ ...fixture.data, status: 'stopped' }), 'utf8');
      changed();
      return { ok: true };
    },
  };
}
