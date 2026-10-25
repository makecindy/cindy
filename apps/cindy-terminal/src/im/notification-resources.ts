import type { RemoteCollectionItem, RemoteResource, RemoteText } from '@cindy/device-link';
import type { TerminalImConnections } from './connections.js';

const text = (en: string, cn: string, tw: string, ja: string, ko: string): RemoteText => ({ fallback: en, translations: { en, 'zh-CN': cn, 'zh-TW': tw, ja, ko } });
export const notificationRef = { collectionId: 'channels', kind: 'im-channel', id: 'wecom-group' };
export function notificationItem(connections: TerminalImConnections): RemoteCollectionItem {
  const state = connections.wecomGroup.getState();
  return { ref: notificationRef, revision: String(connections.version()), links: [], display: {
    title: text('WeCom group notifications', '企业微信群通知', '企業微信群通知', 'WeCom グループ通知', 'WeCom 그룹 알림'),
    status: { label: state.enabled ? text('On', '已开启', '已開啟', 'オン', '켜짐') : text('Off', '已关闭', '已關閉', 'オフ', '꺼짐'), tone: state.enabled ? 'positive' : 'neutral' },
  } };
}
export function notificationResource(connections: TerminalImConnections): RemoteResource {
  const state = connections.wecomGroup.getState();
  const message = { id: 'testMessage', kind: 'text', required: true, label: text('Test message', '测试消息', '測試訊息', 'テストメッセージ', '테스트 메시지') } as const;
  return { ...notificationItem(connections), blocks: [
    { id: 'state', primitive: 'text', fallbackMarkdown: state.maskedKey ?? '' },
    { id: 'enabled', primitive: 'form', fallbackMarkdown: '', data: { actionId: 'enabled', values: { enabled: state.enabled } } },
  ], actions: [
    { id: 'edit', label: text('Configure and test', '配置并测试', '設定並測試', '設定してテスト', '설정 및 테스트'), fields: [
      { id: 'webhookUrl', kind: 'secret', label: 'Webhook URL', required: true }, message,
    ] },
    { id: 'test', label: text('Send test message', '发送测试消息', '傳送測試訊息', 'テストメッセージを送信', '테스트 메시지 보내기'), disabled: !state.configured, fields: [message] },
    { id: 'enabled', label: text('Notifications', '通知', '通知', '通知', '알림'), disabled: !state.configured, fields: [
      { id: 'enabled', kind: 'toggle', label: text('Enabled', '开启', '開啟', '有効', '활성화') },
    ] },
    { id: 'disconnect', label: text('Disconnect', '断开连接', '中斷連線', '切断', '연결 해제'), disabled: !state.configured },
  ] };
}
