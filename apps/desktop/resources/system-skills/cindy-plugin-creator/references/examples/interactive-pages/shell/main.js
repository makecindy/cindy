const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

// 默认模拟后端，不联网、不保存表单。接真实后端时，在工具回调中以
// cindy.fetch({ url, method: 'POST', body: JSON.stringify({ intent, fields }), callId: msg.callId })，
// 替代 mockBackend 调用；JSON 请求加 Content-Type: application/json。
// 检查 ok/status/truncated 后 JSON.parse(r.body)；在 ghost.json.network 声明域名和凭证，见手册 §4.7。
// 凭证由宿主代发，绝不放进 HTML。后端也必须转义数据，只返回可信页面代码。
async function mockBackend(intent, fields) {
  const query = String(fields.query ?? '');
  let title, body;
  if (/统计|趋势|stats/i.test(intent)) {
    title = '本周进展';
    body = '<p>模拟数据：本周完成 18 项，比上周多 6 项。</p><div class="metric">18 <small>项已完成</small></div>';
  } else if (/查询|搜索|search/i.test(intent)) {
    title = '查询记录';
    body = `<p id="query-summary">${query ? `已收到关键词：${escapeHtml(query)}` : '输入关键词，试试按钮提交或按 Enter。'}</p>
      <form data-intent="search"><label for="query">关键词</label>
      <div class="actions"><input id="query" name="query" required value="${escapeHtml(query)}" placeholder="例如：设计稿">
      <button type="submit">查询</button></div></form>`;
  } else if (/概览|首页|overview/i.test(intent)) {
    title = '工作概览';
    body = '<p>界面由模拟后端整块生成，外壳只负责显示和转交操作。</p><div class="metric">3 <small>项今日待办</small></div>';
  } else {
    title = '试试这些意图';
    body = `<p>暂未匹配「${escapeHtml(intent)}」。可以查看概览、统计，或打开查询表单。</p>`;
  }
  return { title, html: `<style>
    .view{border:1px solid var(--color-border-primary,GrayText);border-radius:16px;padding:24px}
    .view h1{font-size:24px;line-height:1.3;margin:12px 0}.view p{color:var(--color-text-secondary,GrayText)}
    .view .mark{width:40px;height:40px}.view .metric{font-size:36px;font-weight:600;margin:24px 0}
    .view small{font-size:14px;font-weight:400}.view .actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
    .view button,.view input{min-height:44px;font:inherit;border:1px solid var(--color-border-primary,GrayText);border-radius:10px;padding:10px 16px;color:inherit;background:var(--color-background-secondary,Canvas)}
    .view input{min-width:0;flex:1;width:100%}.view nav{margin-top:24px;padding-top:16px;border-top:1px solid var(--color-border-primary,GrayText)}
    @media(max-width:600px){.view{padding:16px}.view h1{font-size:22px}}
  </style><section class="view">
    <svg class="mark" viewBox="0 0 40 40" aria-label="页面图标" role="img"><rect x="4" y="4" width="32" height="32" rx="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 14h16M12 20h10M12 26h13" stroke="currentColor" stroke-width="2"/></svg>
    <h1>${escapeHtml(title)}</h1>${body}
    <nav class="actions" aria-label="切换页面"><button type="button" data-intent="overview">概览</button><button type="button" data-intent="stats">统计</button><button type="button" data-intent="search">查询</button></nav>
  </section>` };
}

cindy.onHostMessage(async msg => {
  if (msg.type !== 'tool-call' || !['open_view', 'load_view'].includes(msg.tool)) return;
  try {
    const intent = String(msg.args?.intent ?? 'overview');
    const fields = msg.args?.fields ?? {};
    const page = await mockBackend(intent, fields);
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
      content: [{ type: 'text', text: `已打开${page.title}。` }],
      _meta: { view: { html: page.html } }
    } });
  } catch {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
      isError: true, content: [{ type: 'text', text: '页面暂时无法加载，请稍后重试。' }]
    } });
  }
});
