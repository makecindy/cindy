// 仅内存示例，没有后台轮询。界面需求不唤醒插件，真实工具调用按原流程启动。
let refreshed = 0;
function publish() {
  return cindy.ui?.updateContribution('progress', () => ({ title: `示例刷新 ${refreshed} 次` }));
}
cindy.onHostMessage(message => {
  if (message.type === 'ui-consumers') { void publish(); return; }
  if (message.type !== 'tool-call' || message.tool !== 'refresh') return;
  refreshed++;
  void publish();
  void cindy.send({ type: 'tool-result', callId: message.callId, ok: true,
    result: { content: [{ type: 'text', text: `已刷新 ${refreshed} 次。` }] } });
});
void cindy.ping().then(publish);
