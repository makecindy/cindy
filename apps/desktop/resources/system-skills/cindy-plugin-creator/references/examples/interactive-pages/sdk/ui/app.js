import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: '计划 SDK 示例', version: '1.0.0' }, {}, { autoResize: true });
const status = document.querySelector('#status');
function theme(context) {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [key, value] of Object.entries(context.styles?.variables ?? {}))
    document.documentElement.style.setProperty(key, value);
}
function render(result) {
  if (result.structuredContent) document.querySelector('#title').value = result.structuredContent.title;
  status.textContent = (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
}
app.ontoolresult = render;
app.onhostcontextchanged = theme;
app.ontoolcancelled = () => { status.textContent = '调用已取消'; };
document.querySelector('#save').onclick = async () => {
  const button = document.querySelector('#save'); button.disabled = true;
  try {
    render(await app.callServerTool({ name: 'save_plan', arguments: { title: document.querySelector('#title').value } }, {
      timeout: 30 * 60 * 1000,
      maxTotalTimeout: 30 * 60 * 1000,
      onprogress: progress => { status.textContent = progress.message ?? `已处理 ${progress.progress}`; }
    }));
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
};
await app.connect();
theme(app.getHostContext() ?? {});
document.querySelector('#save').disabled = false;
