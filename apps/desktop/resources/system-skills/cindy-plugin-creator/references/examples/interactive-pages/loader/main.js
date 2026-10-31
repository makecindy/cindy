// 默认完全离线。接入自己的 HTTPS 后端时改为 false，并替换固定域名及清单 network。
const USE_MOCK = true;
class InputError extends Error {}
const BASE = 'https://api.example.com';
const selectedFiles = new Set();
const requests = new Map();
const batches = new Map();
let recordCount = 0;
const records = [];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const text = message => ({ type: 'text', text: message });
const pageResult = html => ({ content: [text('页面已准备好。')], _meta: { view: { html } } });
// structuredContent 会进入模型；不希望模型看到的数据放根 _meta。
const dataResult = data => ({ content: [text('操作已完成。')], structuredContent: data });

// 只允许明确的相对路径和前缀；拒绝完整网址、编码绕过、查询串及父目录。
function endpoint(path, prefixes) {
  if (typeof path !== 'string' || !/^[/][a-zA-Z0-9_/-]+$/.test(path)
    || path.includes('//') || !prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/')))
    throw new InputError('接口路径不在允许范围内。');
  return BASE + path;
}
function checked(response) {
  if (!response || response.ok === false) throw new InputError('请求未完成，请检查网络、权限或取消状态。');
  if (!(response.status >= 200 && response.status < 300)) throw new InputError('服务返回 HTTP ' + response.status + '，请核对后重试。');
  if (response.truncated) throw new InputError('服务结果过大，请缩小查询范围。');
  return response;
}
async function request(msg, path, method, data, query) {
  let url = endpoint(path, ['/view', '/api/items', '/api/records', '/api/imports']);
  const search = Object.entries(query || {}).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value))).join('&');
  if (search) url += '?' + search;
  if (USE_MOCK) return mockBackend(path, method, data || {}, query || {});
  const response = checked(await cindy.fetch({ url, method, callId: msg.callId,
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  }));
  // 不转发响应头或原始错误正文；写操作不自动重试。
  return JSON.parse(response.body);
}

// 以下是模拟后端：同一份模板生成首屏，后续只返回 #content 的内容。
function viewFragment(intent, fields = {}) {
  const known = ['items', 'chart', 'form', 'overview'].includes(intent);
  if (!known) intent = 'overview';
  const title = intent === 'chart' ? 'Chart' : intent === 'form' ? 'Form' : intent === 'items' ? 'Items' : 'Overview';
  const hint = known ? '可查询列表或保存记录。' : '已按总览打开。';
  return '<h1>' + title + '</h1><p>' + escapeHtml(hint) + '</p>'
    + '<nav><button data-view="items">Items</button><button data-view="form">Form</button><button data-view="chart">Chart</button></nav>'
    + (intent === 'chart' ? '<svg viewBox="0 0 240 60" role="img" aria-label="三条记录的数值"><path d="M20 50V30M100 50V10M180 50V20" fill="none" stroke="currentColor" stroke-width="24"/></svg>' : '')
    + '<button id="refresh">查询列表</button><ul id="items"></ul>'
    + '<form id="record-form"><label>标题<input name="title" required maxlength="160" value="' + escapeHtml(fields.title || '') + '"></label><button type="submit">保存记录</button></form>'
    + '<p id="result" role="status"></p>';
}
function fullPage(content) {
  // pageClient 是后端维护的页面脚本；所有动态数据先转义，不拼进 JavaScript。
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Records</title>'
    + '<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:20px;font:14px/1.5 var(--font-sans,system-ui);color:var(--color-text-primary,CanvasText);background:var(--color-background-primary,Canvas)}h1{font-size:24px}nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}button,input{font:inherit;min-height:44px;padding:10px;max-width:100%;border:1px solid var(--color-border-primary,GrayText);border-radius:8px;color:inherit;background:var(--color-background-secondary,Canvas)}label{display:block}input{display:block;width:100%;margin:8px 0}svg,#attachments img{max-width:240px}p,li{overflow-wrap:anywhere}button:disabled{opacity:.5}</style>'
    + '<main id="content">' + content + '</main><div id="attachments"></div><p id="connection" role="status">正在连接…</p>'
    + '<script type="module">import { App } from "@modelcontextprotocol/ext-apps";(' + pageClient.toString() + ')();</script></html>';
}
function pageClient() {
  const app = new App({ name: 'Records', version: '1.0.0' }, {}, { autoResize: true });
  const lifetime = new AbortController();
  const content = document.querySelector('#content');
  const connection = document.querySelector('#connection');
  let pendingWrite, busy = false;
  function theme(context) {
    if (context.theme) document.documentElement.style.colorScheme = context.theme;
    for (const [key, value] of Object.entries(context.styles?.variables || {})) document.documentElement.style.setProperty(key, value);
  }
  async function call(name, args) {
    const result = await app.callServerTool({ name, arguments: args }, {
      timeout: 30 * 60 * 1000, maxTotalTimeout: 30 * 60 * 1000, signal: lifetime.signal,
      onprogress: progress => { connection.textContent = progress.message || '处理中…'; }
    });
    if (result.isError) throw new Error(result.content?.find(x => x.type === 'text')?.text || '操作失败');
    return result;
  }
  function bind() {
    for (const button of content.querySelectorAll('[data-view]')) button.onclick = async () => {
      if (busy) return;
      busy = true; button.disabled = true;
      try {
        const result = await call('load_view', { intent: button.dataset.view });
        // 只插入可信后端的内容片段，不执行其中的 script。App 和这份脚本常驻。
        content.innerHTML = result._meta.view.html;
        // 保留未确认写入的编号：切回表单提交相同内容时沿用，内容变了才换新编号。
        bind();
      } catch (error) { connection.textContent = error.message; }
      finally { busy = false; button.disabled = false; }
    };
    const refresh = content.querySelector('#refresh');
    if (refresh) refresh.onclick = async () => {
      if (busy) return;
      busy = true; refresh.disabled = true;
      try {
        const result = await call('api_read', { path: '/api/items' });
        const items = content.querySelector('#items'); items.replaceChildren();
        for (const item of result.structuredContent.items) {
          const row = document.createElement('li'); row.textContent = item.name; items.append(row);
        }
      } catch (error) { connection.textContent = error.message; }
      finally { busy = false; refresh.disabled = false; }
    };
    const form = content.querySelector('#record-form');
    if (form) {
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      const body = Object.fromEntries(new FormData(form));
      const fingerprint = JSON.stringify(body);
      if (!pendingWrite || pendingWrite.fingerprint !== fingerprint) pendingWrite = { fingerprint, idempotencyKey: crypto.randomUUID() };
      const button = form.querySelector('button'); busy = true; button.disabled = true;
      try {
        const result = await call('api_write', { path: '/api/records', body, idempotencyKey: pendingWrite.idempotencyKey });
        content.querySelector('#result').textContent = '已保存 ' + result.structuredContent.id;
        pendingWrite = undefined;
      } catch (error) { content.querySelector('#result').textContent = error.message; }
      finally { busy = false; button.disabled = false; }
    };
    }
    const confirm = content.querySelector('#confirm-import');
    if (confirm) {
      const idempotencyKey = crypto.randomUUID();
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const result = await call('api_write', { path: '/api/imports/confirm', body: { batchId: confirm.dataset.batch }, idempotencyKey });
          content.querySelector('#result').textContent = '已确认 ' + result.structuredContent.batchId;
        } catch (error) { content.querySelector('#result').textContent = error.message; confirm.disabled = false; }
      };
    }
  }
  // 对话交来的媒体附件由宿主放进 hostContext，每项是 resource_link，地址只读、仅本卡有效。
  function showAttachments() {
    const links = app.getHostContext()?.toolInfo?.tool?._meta?.['cindy/attachments'] ?? [];
    for (const link of links) {
      const file = link._meta?.['cindy/file'];
      if (!file?.mimeType?.startsWith('image/')) continue;
      const image = document.createElement('img');
      image.src = file.url; image.alt = link.name;
      document.querySelector('#attachments').append(image);
    }
  }
  app.onhostcontextchanged = () => theme(app.getHostContext() || {});
  app.onteardown = async () => { lifetime.abort(); return {}; };
  // 首屏已写在 HTML 内；加载器消费过第一次结果，这里不等待它再次发送。
  app.connect().then(() => { theme(app.getHostContext() || {}); bind(); showAttachments(); connection.textContent = '已连接'; })
    .catch(() => { connection.textContent = '无法连接，请检查 Cindy 版本后重新打开。'; });
}
async function mockBackend(path, method, data, query) {
  if (path === '/view') {
    const html = viewFragment(data.intent, data.fields);
    return { html: data.fragment ? html : fullPage(html) };
  }
  if (method === 'GET' && path === '/api/records') return { items: records.filter(record => record.title.includes(String(query.keyword || ''))) };
  if (method === 'GET' && path === '/api/items') return { items: ['Item A', 'Item B', 'Item C'].filter(name => name.includes(String(query.keyword || ''))).map((name, index) => ({ id: String(index + 1), name })) };
  if (method === 'POST' && ['/api/records', '/api/imports/confirm'].includes(path)) {
    if (!data.idempotencyKey) throw new InputError('缺少请求编号。');
    const fingerprint = JSON.stringify([path, data.body]);
    const previous = requests.get(data.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new InputError('同一请求编号不能用于不同内容。');
      return previous.result;
    }
    if (path.endsWith('/confirm') && !batches.has(data.body?.batchId)) throw new InputError('文件批次不存在。');
    const result = path.endsWith('/confirm') ? { batchId: data.body.batchId, status: 'confirmed' } : { id: 'R-' + (++recordCount), title: String(data.body?.title || '') };
    if (!path.endsWith('/confirm')) records.push(result);
    requests.set(data.idempotencyKey, { fingerprint, result }); return result;
  }
  throw new InputError('模拟后端未实现此接口。');
}
function offlineBatch() {
  const batch = { batchId: 'demo-batch', offline: true, total: 3, rows: [{ value: 'Record A' }, { value: 'Record B' }], errors: [{ line: 4, message: '缺少标题' }] };
  batches.set(batch.batchId, batch);
  return batch;
}
// 预览字段：batchId、total、rows（前几行）、errors（[{line,message}]）。取消回到总览，不提交。
function importPreview(batch) {
  const rows = (batch.rows || []).map(row => '<li>' + escapeHtml(JSON.stringify(row)) + '</li>').join('');
  const errors = (batch.errors || []).map(error => '<li>第 ' + escapeHtml(error.line) + ' 行：' + escapeHtml(error.message) + '</li>').join('');
  return fullPage((batch.offline ? '<p role="note">离线示例：未读取真实文件，接入后端后解析真实内容。</p>' : '')
    + '<h1>文件预览</h1><p>共 ' + escapeHtml(batch.total ?? (batch.rows || []).length) + ' 行，出错 ' + escapeHtml((batch.errors || []).length) + ' 行。</p>'
    + '<ul>' + rows + '</ul>' + (errors ? '<ul id="import-errors">' + errors + '</ul>' : '')
    + '<button id="confirm-import" data-batch="' + escapeHtml(batch.batchId) + '">确认导入</button><button data-view="overview">取消</button><p id="result" role="status"></p>');
}
cindy.onHostMessage(async msg => {
  if (msg.type !== 'tool-call') return;
  const a = msg.args || {};
  let result;
  try {
    if (msg.tool === 'open_view' || msg.tool === 'load_view') {
      const page = await request(msg, '/view', 'POST', { intent: a.intent, fields: a.fields || {}, fragment: msg.tool === 'load_view' });
      if (typeof page.html !== 'string' || !page.html.trim()) throw new InputError('后端没有返回有效页面。');
      result = pageResult(page.html);
    } else if (msg.tool === 'show_page') {
      if (typeof a.html !== 'string' || !a.html.trim() || a.html.length > 200000) throw new InputError('页面为空或过大。');
      result = { content: [text(String(a.title || '页面').slice(0, 160))], _meta: { view: { html: a.html } } };
    } else if (msg.tool === 'api_read') {
      endpoint(a.path, ['/api/items', '/api/records']);
      result = dataResult(await request(msg, a.path, 'GET', undefined, a.query));
    } else if (msg.tool === 'api_write') {
      endpoint(a.path, ['/api/records', '/api/imports/confirm']);
      if (typeof a.idempotencyKey !== 'string' || !a.idempotencyKey || a.idempotencyKey.length > 64) throw new InputError('缺少有效请求编号。');
      result = dataResult(await request(msg, a.path, 'POST', { body: a.body, idempotencyKey: a.idempotencyKey }));
    } else if (msg.tool === 'pick_files') {
      const picked = await cindy.pick({ mode: 'file', into: 'library', path: 'imports', accept: a.accept || [], multiple: !!a.multiple, callId: msg.callId });
      const files = (picked.files || []).map(file => {
        selectedFiles.add(file.ref); return { name: file.name, ref: file.ref, size: file.size };
      });
      result = { ...dataResult({ files }), ...(!picked.ok ? { isError: true, content: [text('文件选择未完成；已成功导入的文件仍保留。')] } : {}) };
    } else if (msg.tool === 'upload_files') {
      const url = endpoint(a.path, ['/api/imports/stage']);
      if (!Array.isArray(a.files) || !a.files.length || a.files.length > 4 || a.files.some(ref => !selectedFiles.has(ref) || !ref.startsWith('library:'))) throw new InputError('请先选择要上传的文件。');
      // 离线不上传；返回与 import_file 相同、标明离线的示例批次，页面照常预览和确认。
      if (USE_MOCK) result = dataResult(offlineBatch());
      else result = dataResult(JSON.parse(checked(await cindy.fetch({ url, method: 'POST', upload: { library: a.files.map(ref => ref.slice(8)), field: 'file', fields: a.fields }, callId: msg.callId })).body));
    } else if (msg.tool === 'fetch_file') {
      const url = endpoint(a.path, ['/api/files']);
      // 与 Library 路径规则一致：每段最多 64 字符，不以点结尾，不用 Windows 保留名。
      if (typeof a.name !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/.test(a.name) || a.name.endsWith('.')
        || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(a.name)) throw new InputError('请使用简单文件名。');
      if (USE_MOCK) {
        // 离线示例：把当前记录写成 CSV 放进 Library，页面可显示或用 downloadFile 另存。
        const cell = value => '"' + String(value).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""') + '"';
        const csv = 'id,title\r\n' + records.map(record => cell(record.id) + ',' + cell(record.title) + '\r\n').join('');
        const written = await cindy.library({ op: 'write', path: 'downloads/' + a.name, content: csv });
        if (!written?.ok) throw new InputError('示例文件写入失败。');
        result = { content: [text('离线示例：已生成记录 CSV。'), { type: 'resource_link', uri: 'library:downloads/' + a.name, name: a.name, mimeType: 'text/csv' }] };
      } else {
        const response = checked(await cindy.fetch({ url, as: 'library', path: 'downloads/' + a.name, callId: msg.callId }));
        if (!response.library) throw new InputError('后端未返回文件。');
        result = { content: [text('文件已下载。'), { type: 'resource_link', uri: response.library.ref, name: a.name }] };
      }
    } else if (msg.tool === 'import_file') {
      let batch;
      if (USE_MOCK) {
        // 离线模式读不到交接的文件（dir 票据只能交给 uploadDir），页面会明确标出这是示例数据。
        batch = offlineBatch();
      } else {
        if (!a.dir_deposit?.token) throw new InputError('请通过 ghost_call.dir 交接单文件后重试。');
        // 在这次模型工具调用里立即消费；不要把 token 留给页面或下一次工具调用。
        batch = JSON.parse(checked(await cindy.fetch({ url: BASE + '/api/imports/stage', method: 'POST',
          uploadDir: { token: a.dir_deposit.token, fileField: 'file' }, callId: msg.callId
        })).body);
      }
      result = pageResult(importPreview(batch));
    } else throw new InputError('未知工具。');
  } catch (error) {
    // 仅返回本示例控制的错误；JSON 解析等内部错误使用通用提示。
    const message = error instanceof InputError ? error.message : '操作未完成，请检查服务连接后重试。';
    result = { isError: true, content: [text(message)] };
  }
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result });
});
