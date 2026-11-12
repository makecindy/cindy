// 仅内存示例，没有后台轮询。界面需求不唤醒插件，真实工具调用按原流程启动。
let refreshed = 0;
function publish() {
  return cindy.ui?.updateContribution('progress', () => ({ title: `示例刷新 ${refreshed} 次` }));
}
cindy.onHostMessage(message => {
  if (message.type === 'ui-consumers') { void publish(); return; }
  if (message.type !== 'tool-call') return;
  if (message.tool === 'prepare_attachment') {
    // Re-emit the selected handoff under a new name; the Host re-reads the owned ref.
    const file = message.args?.cindy_handoff_files?.[0];
    const result = file ? { handled: true, text: `附件：${file.name}（${file.size} 字节）`,
      files: [{ type: 'resource_link', uri: file.ref, name: `prepared-${file.name}`.slice(0, 200) }] } : { handled: false };
    void cindy.send({ type: 'tool-result', callId: message.callId, ok: true,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    return;
  }
  if (message.tool === 'complete') {
    const query = typeof message.args?.query === 'string' ? message.args.query : '';
    void cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result: {
      content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'reference', label: query ? `示例引用：${query}` : '示例引用', insertText: `示例引用 ${query || '#1'}` }] }) }],
    } });
    return;
  }
  if (message.tool !== 'refresh') return;
  refreshed++;
  void publish();
  void cindy.send({ type: 'tool-result', callId: message.callId, ok: true,
    result: { content: [{ type: 'text', text: `已刷新 ${refreshed} 次。` }] } });
});
void cindy.ping().then(publish);
