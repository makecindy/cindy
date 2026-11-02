const requests = new Map();
let saved = 0;
function handleInteractivePage(msg) {
  if (msg.type !== 'tool-call' || !['open_view', 'save_record'].includes(msg.tool)) return false;
  const { title = '记录', idempotencyKey } = msg.args || {};
  let result;
  if (msg.tool === 'open_view') {
    result = { content: [{ type: 'text', text: '已打开记录表单。' }], structuredContent: { title } };
  } else if (msg.tool === 'save_record' && typeof title === 'string' && title.length <= 160
    && typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 64) {
    // 仅演示：插件重启即清空。真实服务按用户 + 请求编号建立数据库唯一键；同编号不同内容拒绝。
    const previous = requests.get(idempotencyKey);
    if (previous && previous.title !== title)
      result = { isError: true, content: [{ type: 'text', text: '同一请求编号不能用于不同内容。' }] };
    else {
      if (!previous) requests.set(idempotencyKey, { title, result: {
        content: [{ type: 'text', text: '已保存记录。' }], structuredContent: { title, saved: ++saved } } });
      result = requests.get(idempotencyKey).result;
    }
  } else result = { isError: true, content: [{ type: 'text', text: '工具或参数不正确。' }] };
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result });
  return true;
}
cindy.onHostMessage(handleInteractivePage);
