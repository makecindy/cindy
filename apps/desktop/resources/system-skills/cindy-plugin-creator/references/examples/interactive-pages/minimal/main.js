let savedPlans = 0;
function handleInteractivePage(msg) {
  if (msg.type !== 'tool-call' || !['open_planner', 'save_plan'].includes(msg.tool)) return false;
  const title = String(msg.args?.title ?? '我的计划');
  if (msg.tool === 'save_plan') savedPlans++;
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
    content: [{ type: 'text', text: `${title}（已暂存 ${savedPlans} 次）` }],
    structuredContent: { title, savedPlans },
    _meta: { note: '这里只在页面显示，不交给模型。' }
  } });
  return true;
}
cindy.onHostMessage(handleInteractivePage);
