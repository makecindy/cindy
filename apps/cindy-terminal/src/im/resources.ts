import type { RemoteResourceRegistry, RemoteText, RemoteCollectionItem, RemoteActionDescriptor } from '@cindy/device-link';
import path from 'node:path';
import { isBotVisibleRemotely } from '@cindy/app-runtime/botRemoteVisibility';
import { notificationItem, notificationResource, notificationRef } from './notification-resources.js';
import type { TerminalConfiguration } from '../configuration.js';
import { type TerminalImChannel, type TerminalImConnections } from './connections.js';
import type { TerminalTaskHost } from '../tasks/host.js';
const label = (en: string, cn: string, tw: string, ja: string, ko: string): RemoteText => ({ fallback: en, translations: { en, 'zh-CN': cn, 'zh-TW': tw, ja, ko } });
const statusLabels = {
  connected: label('Connected', '已连接', '已連線', '接続済み', '연결됨'),
  connecting: label('Connecting', '连接中', '連線中', '接続中', '연결 중'),
  idle: label('Not connected', '未连接', '未連線', '未接続', '연결 안 됨'),
  error: label('Connection error', '连接失败', '連線失敗', '接続エラー', '연결 오류'),
  offline: label('Offline', '已离线', '已離線', 'オフライン', '오프라인'),
  conflict: label('Connected elsewhere', '已在其他设备连接', '已在其他裝置連線', '別のデバイスで接続中', '다른 기기에서 연결됨'),
};

const names: Record<TerminalImChannel, RemoteText> = {
  wechat:label('WeChat','微信','微信','WeChat','WeChat'),
  feishu: label('Feishu / Lark', '飞书 / Lark', '飛書 / Lark', 'Feishu / Lark', 'Feishu / Lark'), discord: 'Discord', wecom: label('WeCom', '企业微信', '企業微信', 'WeCom', 'WeCom'), dingtalk: label('DingTalk', '钉钉', '釘釘', 'DingTalk', 'DingTalk'), telegram: 'Telegram',
};
const credentialFields: Record<TerminalImChannel, NonNullable<RemoteActionDescriptor['fields']>> = {
  wechat:[],
  feishu: [
    { id: 'service', kind: 'select', label: label('Service', '服务', '服務', 'サービス', '서비스'), required: true, options: [{ value: 'feishu', label: label('Feishu', '飞书', '飛書', 'Feishu', 'Feishu') }, { value: 'lark', label: 'Lark' }] },
    { id: 'appId', kind: 'text', label: 'App ID', required: true },
    { id: 'appSecret', kind: 'secret', label: 'App Secret', required: true },
  ],
  discord: [
    { id: 'token', kind: 'secret', label: label('Bot token', '机器人令牌', '機器人權杖', 'Bot トークン', '봇 토큰'), required: true },
    { id: 'ownerUserId', kind: 'text', label: label('Your Discord user ID', '你的 Discord 用户 ID', '你的 Discord 使用者 ID', 'あなたの Discord ユーザー ID', '내 Discord 사용자 ID'), required: true },
  ],
  wecom: [{ id: 'botId', kind: 'text', label: 'Bot ID', required: true }, { id: 'secret', kind: 'secret', label: 'Secret', required: true }],
  dingtalk: [{ id: 'appKey', kind: 'text', label: 'AppKey', required: true }, { id: 'appSecret', kind: 'secret', label: 'AppSecret', required: true }],
  telegram: [
    { id: 'token', kind: 'secret', label: label('Bot token', '机器人令牌', '機器人權杖', 'Bot トークン', '봇 토큰'), required: true },
    { id: 'ownerUserId', kind: 'text', label: label('Your Telegram user ID', '你的 Telegram 用户 ID', '你的 Telegram 使用者 ID', 'あなたの Telegram ユーザー ID', '내 Telegram 사용자 ID'), required: true },
  ],
};
const permissionOptions = [
  { value: 'auto', label: label('Auto-review', '自动审批', '自動審批', '自動承認', '자동 승인') },
  { value: 'ask', label: label('Ask', '询问', '詢問', '確認する', '확인') },
  { value: 'bypassPermissions', label: label('Full access', '完全访问', '完全存取', 'フルアクセス', '전체 액세스') },
];
const participation = [
  { value: 'mention', label: label('When mentioned', '提到时回复', '提及時回覆', 'メンション時', '멘션할 때') },
  { value: 'always', label: label('Decide when to reply', '自主判断回复', '自主判斷回覆', '返信を判断', '답장 여부 판단') },
];
export function registerImResources(registry: RemoteResourceRegistry, connections: TerminalImConnections, tasks: TerminalTaskHost, configuration: TerminalConfiguration) {
  const ref = (id: TerminalImChannel) => ({ collectionId: 'channels', kind: 'im-channel', id });
  const item = (id: TerminalImChannel): RemoteCollectionItem => ({
    ref: ref(id), revision: String(connections.version()), links: [],
    display: { title: names[id], status: { label: statusLabels[connections.status(id).kind],
      tone: connections.status(id).kind === 'connected' ? 'positive' : connections.status(id).kind === 'error' ? 'critical' : 'neutral' } },
  });
  registry.register({
    collection: { id: 'channels', resourceKind: 'im-channel', title: label('Channels', '聊天渠道', '聊天渠道', 'チャット連携', '채팅 채널'), placement: 'settings' },
    list: async () => ({ collectionId: 'channels', revision: String(connections.version()), items: [...connections.channelIds().map(item), notificationItem(connections)] }),
    get: async (_context, request) => {
      if (request.ref.id === notificationRef.id) return notificationResource(connections);
      const id = connections.channel(request.ref.id);
      const status = await connections.readConfiguration(id) as Record<string, unknown>;
      const authorizationUrl=id==='wechat'?connections.wechatRuntime?.authorization():undefined;
      const wechatSettings=id==='wechat'?connections.wechatRuntime?.settings.readWechatChannelSettings():undefined;
      const teammates=id==='wechat'&&tasks.bots?await tasks.bots.profiles.listBotRemoteResourceSources():[];
      const values = Object.fromEntries(credentialFields[id].filter(field => field.kind !== 'secret').map(field => [field.id, status[field.id] ?? '']));
      const defaults = tasks.channelDefaults.read(id);
      const selected = defaults.agents[defaults.agentKind];
      const behavior = id === 'telegram' ? connections.telegramSettings.behavior() : undefined;
      const persona = id === 'telegram' ? connections.telegramSettings.persona() : undefined;
      const groups = id === 'telegram' ? await connections.groups.channel('telegram-personal').listKnownGroups(connections.telegram.botContextId) : [];
      const routes = (await tasks.models.views()).filter(provider => provider.connected && !provider.suspended).flatMap(provider =>
        Object.entries(provider.models).flatMap(([agentKind, models]) => (models ?? []).filter(model => !model.disabled && model.defaultEnabled !== false).map(model => ({
          value: JSON.stringify({ agentKind, providerId: provider.id, model: model.id }), label: `${provider.name} / ${model.name} · ${agentKind}`,
        }))));
      return { ...item(id), blocks: [
        ...(id==='wechat'&&authorizationUrl?[{id:'authorization',primitive:'text',fallbackMarkdown:`[WeChat](${authorizationUrl})`}]:[]),
        ...(id==='wechat'?[]:[{ id: 'config', primitive: 'form', data: { actionId: 'edit', values }, fallbackMarkdown: '' }]),
        ...(wechatSettings?[
          {id:'companion',primitive:'form',data:{actionId:'companion',values:{botId:wechatSettings.companionBotId??''}},fallbackMarkdown:''},
          {id:'directory',primitive:'form',data:{actionId:'directory',values:{path:wechatSettings.workingDir??''}},fallbackMarkdown:''},
        ]:[]),
        { id: 'model', primitive: 'text', fallbackMarkdown: `${defaults.agentKind} · ${selected.model}` },
        { id: 'model-config', primitive: 'form', data: { actionId: 'model', values: { route: JSON.stringify({ agentKind: defaults.agentKind, providerId: selected.providerId, model: selected.model }) } }, fallbackMarkdown: '' },
        { id: 'permissions', primitive: 'form', data: { actionId: 'permissions', values: { permissionMode: defaults.permissionMode, groupPermissionMode: defaults.groupPermissionMode } }, fallbackMarkdown: '' },
        ...(behavior ? [{ id: 'behavior', primitive: 'form', data: { actionId: 'behavior', values: behavior }, fallbackMarkdown: '' }] : []),
        ...(persona ? [{ id: 'persona', primitive: 'form', data: { actionId: 'persona', values: persona }, fallbackMarkdown: '' }] : []),
        ...(id === 'telegram' ? [{ id: 'online', primitive: 'form', data: { actionId: 'online', values: { online: connections.telegram.getStatus().kind === 'connected' } }, fallbackMarkdown: '' }] : []),
        ...(id === 'feishu' ? [{ id: 'announcement', primitive: 'form', data: { actionId: 'announcement', values: { enabled: status.lifecycleAnnouncement !== false } }, fallbackMarkdown: '' }] : []),
        ...(id === 'feishu' ? [{ id: 'connect', primitive: 'form', data: { actionId: 'connect', values: { service: status.service ?? 'feishu' } }, fallbackMarkdown: '' }] : []),
      ], actions: [
        { id: id==='wechat'?'authorize':'edit', label: id==='wechat'?label('Connect','连接','連接','接続','연결'):label('Configure', '配置', '設定', '設定', '설정'), fields: credentialFields[id] },
        ...(wechatSettings?[
          {id:'companion',label:label('Teammate','伙伴','夥伴','チームメイト','팀원'),fields:[{id:'botId',kind:'select' as const,label:label('Teammate','伙伴','夥伴','チームメイト','팀원'),options:[{value:'',label:label('Personal connection','个人连接','個人連接','個人接続','개인 연결')},...teammates.filter(bot=>bot.status==='active'&&isBotVisibleRemotely(bot)).map(bot=>({value:bot.id,label:bot.name}))]}]},
          {id:'directory',label:label('Working directory','工作目录','工作目錄','作業ディレクトリ','작업 디렉터리'),fields:[{id:'path',kind:'text' as const,label:label('Path','路径','路徑','パス','경로'),required:true}]},
          {id:'reset-directory',label:label('Reset directory','重置工作目录','重設工作目錄','ディレクトリをリセット','디렉터리 재설정')},
          ...(authorizationUrl?[{id:'cancel-authorization',label:label('Cancel','取消','取消','キャンセル','취소')}]:[]),
        ]:[]),
        ...(id === 'feishu' ? [{ id: 'connect', label: label('Create and connect', '创建并连接', '建立並連線', '作成して接続', '만들고 연결'), fields: [credentialFields.feishu[0]!] },
          { id: 'announcement', label: label('Online notifications', '上下线通知', '上下線通知', 'オンライン通知', '온라인 알림'), fields: [{ id: 'enabled', kind: 'toggle' as const, label: label('Enabled', '开启', '開啟', '有効', '사용') }] }] : []),
        { id: 'model', label: label('Default model', '默认模型', '預設模型', '既定モデル', '기본 모델'), disabled: routes.length === 0,
          fields: [{ id: 'route', kind: 'select', label: label('Model', '模型', '模型', 'モデル', '모델'), required: true, options: routes }] },
        { id: 'permissions', label: label('Permissions', '权限', '權限', '権限', '권한'), fields: [
          { id: 'permissionMode', kind: 'select', required: true, label: label('Direct messages', '私聊', '私聊', 'ダイレクトメッセージ', '다이렉트 메시지'), options: permissionOptions },
          { id: 'groupPermissionMode', kind: 'select', required: true, label: label('Group messages', '群聊', '群聊', 'グループ', '그룹'), options: permissionOptions },
        ] },
        ...(id === 'telegram' ? telegramActions(groups) : []),
        { id: 'disconnect', label: label('Disconnect', '断开连接', '中斷連線', '切断', '연결 해제') },
      ] };
    },
    invoke: async (context, request) => {
      context.assertCurrent?.();
      if (request.resourceRef?.id === notificationRef.id) {
        if (request.actionId === 'edit') throw new Error('PROTECTED_INPUT_REQUIRED');
        if (request.actionId === 'configuration:open') return { effects: [], result: configuration.open({ collectionId: 'channels', resourceId: notificationRef.id, actionId: 'edit' }, { source: 'local', deviceId: context.controllerDeviceId, assertCurrent: context.assertCurrent }) };
        await connections.notificationAction(request.actionId, request.input);
        return { effects: [{ kind: 'refresh-resource', ref: notificationRef }, { kind: 'refresh-collection', collectionId: 'channels' }] };
      }
      const id = connections.channel(request.resourceRef?.id ?? '');
      if (request.actionId === 'edit' || request.actionId === 'connect') throw new Error('PROTECTED_INPUT_REQUIRED');
      if (request.actionId === 'configuration:open') {
        const action = (request.input as { actionId?: unknown } | undefined)?.actionId === 'connect' ? 'connect' : 'edit';
        return { effects: [], result: configuration.open({ collectionId: 'channels', resourceId: id, actionId: action }, { source: 'local', deviceId: context.controllerDeviceId, assertCurrent: context.assertCurrent }) };
      }
      if(id==='wechat'&&request.actionId==='authorize')await connections.invoke('wechatBot:authorize',undefined);
      else if(id==='wechat'&&request.actionId==='cancel-authorization')await connections.invoke('wechatBot:cancel-authorization',undefined);
      else if(id==='wechat'&&request.actionId==='companion'){
        const botId=(request.input as {botId?:unknown}|undefined)?.botId;
        if(typeof botId==='string'&&botId&&(!tasks.bots||!isBotVisibleRemotely(await tasks.bots.profiles.getBotRemoteResourceSource(botId))))throw new Error('BOT_NOT_FOUND');
        context.assertCurrent?.();
        await connections.invoke('wechatBot:set-companion',botId===''?null:botId);
      }else if(id==='wechat'&&request.actionId==='directory'){
        const dir=(request.input as {path?:unknown}|undefined)?.path;
        if(typeof dir!=='string'||!path.isAbsolute(dir))throw new Error('INVALID_WORKING_DIRECTORY');
        await connections.invoke('terminal:wechat:set-working-directory',dir);
      }else if(id==='wechat'&&request.actionId==='reset-directory')await connections.invoke('wechatBot:reset-working-directory',undefined);
      else if (request.actionId === 'model') {
        const input = request.input as { route?: unknown } | undefined;
        if (typeof input?.route !== 'string') throw new Error('INVALID_MODEL_SELECTION');
        const selected = await tasks.models.select(JSON.parse(input.route));
        context.assertCurrent?.();
        const current = tasks.channelDefaults.read(id), route = selected.selection;
        await tasks.channelDefaults.update({ agentKind: route.agentKind, agents: { [route.agentKind]: {
          agentDeviceId: null, providerId: route.providerId, model: route.model, effort: route.effort ?? current.agents[route.agentKind].effort,
        } } }, id);
      } else if (request.actionId === 'permissions') {
        const input = request.input as Record<string, unknown> | undefined;
        await tasks.channelDefaults.update({ permissionMode: input?.permissionMode, groupPermissionMode: input?.groupPermissionMode }, id);
      } else if (id === 'feishu' && request.actionId === 'announcement') await connections.invoke('feishuBot:set-lifecycle-announcement', request.input);
      else if (id === 'telegram' && request.actionId === 'behavior') await connections.invoke('telegramBot:set-behavior', request.input);
      else if (id === 'telegram' && request.actionId === 'persona') await connections.invoke('telegramBot:set-persona', request.input);
      else if (id === 'telegram' && request.actionId === 'participation') await connections.invoke('telegramBot:set-group-activation', request.input);
      else if (id === 'telegram' && request.actionId === 'online') await connections.invoke('telegramBot:set-online', request.input);
      else if (request.actionId === 'disconnect') await connections.disconnect(id);
      else throw new Error('INVALID_ACTION');
      return { effects: [{ kind: 'refresh-resource', ref: ref(id) }, { kind: 'refresh-collection', collectionId: 'channels' }] };
    },
  });
}

function telegramActions(groups: Array<{ chatId: string; chatName: string | null }>): RemoteActionDescriptor[] {
  return [
    { id: 'behavior', label: label('Replies', '回复', '回覆', '返信', '답장'), fields: [
      { id: 'emojiReactions', kind: 'select', label: label('Reactions', '表情回应', '表情回應', 'リアクション', '반응'), options: [
        { value: 'off', label: label('Off', '关闭', '關閉', 'オフ', '끄기') },
        { value: 'minimal', label: label('Minimal', '简洁', '簡潔', '最小限', '최소') },
        { value: 'expressive', label: label('Expressive', '丰富', '豐富', '豊か', '풍부하게') },
      ] },
      ...(['replyQuoteDm', 'replyQuoteGroup'] as const).map(id => ({ id, kind: 'select',
        label: id === 'replyQuoteDm' ? label('Quote in direct messages', '私聊引用', '私聊引用', 'DM の引用', 'DM 인용') : label('Quote in groups', '群聊引用', '群聊引用', 'グループの引用', '그룹 인용'),
        options: [{ value: 'off', label: label('Off', '关闭', '關閉', 'オフ', '끄기') }, { value: 'first', label: label('First reply', '首次回复', '首次回覆', '最初の返信', '첫 답장') },
          ...(id === 'replyQuoteGroup' ? [{ value: 'all', label: label('Every reply', '每次回复', '每次回覆', '毎回', '모든 답장') }] : [])],
      })),
    ] },
    { id: 'persona', label: label('Bot profile', '机器人资料', '機器人資料', 'Bot プロフィール', '봇 프로필'), fields: [
      { id: 'botName', kind: 'text', label: label('Name', '名字', '名字', '名前', '이름') },
      { id: 'soul', kind: 'multiline', label: label('Persona', '人格', '人格', 'ペルソナ', '페르소나') },
      { id: 'syncProfile', kind: 'toggle', label: label('Update Telegram name', '同步 Telegram 名字', '同步 Telegram 名字', 'Telegram の名前を更新', 'Telegram 이름 업데이트') },
    ] },
    { id: 'participation', label: label('Group participation', '群聊参与', '群聊參與', 'グループへの参加', '그룹 참여'), disabled: groups.length === 0, fields: [
      { id: 'chatId', kind: 'select', required: true, label: label('Group', '群聊', '群聊', 'グループ', '그룹'), options: groups.map(group => ({ value: group.chatId, label: group.chatName || group.chatId })) },
      { id: 'mode', kind: 'select', required: true, label: label('Reply when', '回复时机', '回覆時機', '返信のタイミング', '답장 시점'), options: participation },
    ] },
    { id: 'online', label: label('Online status', '在线状态', '上線狀態', 'オンライン状態', '온라인 상태'), fields: [
      { id: 'online', kind: 'toggle', label: label('Online', '上线', '上線', 'オンライン', '온라인') },
    ] },
  ];
}
