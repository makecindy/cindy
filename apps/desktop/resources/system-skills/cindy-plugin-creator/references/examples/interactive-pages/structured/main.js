// schema 帮模型组织输入，插件仍在交卷前校验，避免错误留到页面才出现。
function objectWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function textWithin(value, max) {
  return typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= max;
}
function validate(args) {
  if (!objectWithKeys(args, ['title', 'rows'])) return 'args 只接受 title 和 rows 两个字段。';
  if (!textWithin(args.title, 160)) return 'title 必须是 1–160 字符的字符串。';
  if (!Array.isArray(args.rows) || args.rows.length < 1 || args.rows.length > 20)
    return 'rows 必须是包含 1–20 项的数组，每项为 {name, value}。';
  for (const [index, row] of args.rows.entries()) {
    if (!objectWithKeys(row, ['name', 'value']) || !textWithin(row.name, 80) || !textWithin(row.value, 240))
      return `rows[${index}] 必须为 {name, value}，name 为 1–80 字符，value 为 1–240 字符；不接受其他字段。`;
  }
}
cindy.onHostMessage(msg => {
  if (msg.type !== 'tool-call' || msg.tool !== 'open_view') return;
  const error = validate(msg.args);
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: error
    ? { isError: true, content: [{ type: 'text', text: error }] }
    : { content: [{ type: 'text', text: '记录已整理到页面。' }], _meta: { view: msg.args } }
  });
});
