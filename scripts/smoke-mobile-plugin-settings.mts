/** Browser-only synthetic fixture. No plugin is installed and no user configuration is read. */
import { createServer } from "node:http";
import {
  settingsBridgeAsset,
  prepareSettingsHtml,
  PLUGIN_SETTINGS_CSP,
} from "../apps/mobile/src/plugins/pluginSettingsHtml";

const html =
  '<!doctype html><html><head><title>Original settings bridge check</title><link rel="stylesheet" href="./style.css"><script type="module" src="./main.js"></script></head><body><label>Region <input id="region" value="test"></label><button id="save">Save test value</button><output id="result">Loading original module…</output></body></html>';
const module = `import { originalLabel } from './child.js';
const result = document.querySelector('#result');
const channel = new BroadcastChannel('fixture-dynamic');
channel.onmessage = event => { document.body.dataset.channel = event.data.kind; };
const xhr = new XMLHttpRequest();
xhr.open('GET', '../kv'); xhr.responseType = 'json';
xhr.onload = () => { document.body.dataset.xhr = xhr.response.region; result.textContent = originalLabel; };
xhr.send();
channel.postMessage({kind:'ready'});
document.querySelector('#save').onclick = async () => {
  await fetch('/kv', {method:'PUT',body:JSON.stringify({region:document.querySelector('#region').value})});
  const value = await (await fetch('/kv')).json();
  result.textContent = 'Saved on fake target: ' + value.region;
};
fetch('./data.json').then(r=>r.json()).then(value=>document.body.dataset.resource=value.original);
fetch('https://example.invalid/kv').then(()=>document.body.dataset.escape='bad',()=>document.body.dataset.escape='blocked');`;
const files = new Map([
  ["ui/settings.html", { mime: "text/html", text: html }],
  ["ui/main.js", { mime: "application/javascript", text: module }],
  [
    "ui/child.js",
    {
      mime: "application/javascript",
      text: 'export const originalLabel = "Original nested module loaded";',
    },
  ],
  [
    "ui/style.css",
    {
      mime: "text/css",
      text: "body{font:16px system-ui;color:var(--text-primary);background:var(--panel-bg);padding:16px}input,button{font:inherit;margin:8px}output{display:block;background-image:url(./icon.svg);padding:16px}",
    },
  ],
  [
    "ui/icon.svg",
    {
      mime: "image/svg+xml",
      text: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="none" d="M0 0"/></svg>',
    },
  ],
  ["ui/data.json", { mime: "application/json", text: '{"original":"loaded"}' }],
]);
const document = {
  pageId: "synthetic-settings",
  pluginId: "synthetic",
  manifestId: "synthetic",
  name: "Synthetic",
  entry: "ui/settings.html",
  files: [...files].map(([path, file]) => ({
    path,
    mime: file.mime,
    size: Buffer.byteLength(file.text),
  })),
};
const bridge = settingsBridgeAsset(document, {
  dark: false,
  colors: { "panel-bg": "ivory", "text-primary": "black" },
});
// Replace only the native transport in this fixture. API requests reaching HTTP are a failure.
const fakeNative = `(()=>{let kv={region:'test'};let seq=0;window.__fixtureCommands=[];
window.ReactNativeWebView={postMessage(raw){const m=JSON.parse(raw);if(!m.command)return;
window.__fixtureCommands.push(m.command);const c=m.command;
queueMicrotask(()=>{let value={};if(c.kind==='fetch'){if(c.method==='PUT')kv=JSON.parse(c.body);value={status:200,mime:'application/json',base64:btoa(unescape(encodeURIComponent(JSON.stringify(kv))))}}
window.__cindySettingsReceive({kind:'reply',id:m.id,ok:true,value});
if(c.kind==='post')window.__cindySettingsReceive({kind:'events',events:[{sequence:++seq,channel:c.channel,data:c.data}]});});}};})();\n`;
files.set(bridge.path, {
  mime: "application/javascript",
  text: fakeNative + bridge.text,
});
files.set(document.entry, {
  mime: "text/html",
  text: prepareSettingsHtml(html, bridge.path),
});
const server = createServer((request, response) => {
  const path = new URL(request.url!, "http://localhost").pathname.slice(1);
  const file = files.get(path);
  if (request.method !== "GET" || !file) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": file.mime,
    "Content-Security-Policy": PLUGIN_SETTINGS_CSP,
    "Cache-Control": "no-store",
  });
  response.end(file.text);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object")
    process.stdout.write(
      `Synthetic original settings: http://127.0.0.1:${address.port}/${document.entry}\n`,
    );
});
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
